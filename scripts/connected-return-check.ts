/** Real Postgres and MCP SDK; provider/location responses are synthetic. */
import {checkConnectedReturnWorker} from './connected-return-worker-check.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Exchange } from '../src/commerce/domain.js';
import { prepareConnectedReturn } from '../src/commerce/connected-return.js';
import { digest } from '../src/commerce/domain.js';
import type { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { executeMcp,type ServiceInvocation } from '../src/commerce/mcp-execution.js';
import { prepareShippingValidation } from '../src/commerce/shipping-validation.js';
import { prepareShippingRates } from '../src/commerce/shipping-rates.js';
import { prepareShippingOption,returnShippingOptions } from '../src/commerce/shipping-option.js';
import { verifyDropoff } from '../src/commerce/verified-dropoff.js';
import { verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { shippoAddressArguments,shippoOperationMetadata } from '../src/commerce/shippo-evidence.js';
import { upsLocationHtml,upsLocationUrl } from '../test/fixtures/ups-dropoff.js';
import { uspsLocationHtml,uspsLocationUrl } from '../test/fixtures/usps-dropoff.js';

export async function checkConnectedReturn(repository:CommerceRepository,original:Exchange,connection:string,root:string,tools:ServiceInvocation['tool'][],noPrinter=false) {
  const pool=repository.pool,A=original.buyerId,B=original.sellerId;
  const originalOperations=(await pool.query('select * from pilot_operations where exchange_id=$1',[original.id])).rows;
  const originalBuyer=await repository.privateInput(original,A),originalSeller=await repository.privateInput(original,B);
  const service=new CommerceService(repository,[A,B],original.mode,undefined,null,true);
  const command=async(actor:string,input:unknown)=>service.command(actor,original.id,randomUUID(),(await service.get(actor,original.id)).revision,input);
  const revision=async()=>(await repository.get(original.id,B)).revision;
  const connected=(await pool.query('select generation,endpoint from pilot_connections where id=$1',[connection])).rows[0];
  const describe=async(name:string,kind:string,fields:Record<string,string>)=>{
    const id=randomUUID();
    await pool.query(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,endpoint,
      invocation,explanation,digest,call_digest,state,result,expires_at)
      values($1,$2,$3,$4,$5,$6,1,$7,$8,$9,'return fixture description',$10,$11,'returned',$12,now()+interval '1 hour')`,
      [id,original.id,B,connection,original.mode,randomUUID(),connected.generation,connected.endpoint,
        {tool:{name:'shippo_describe_tool',description:'Describe',inputSchema:{type:'object'}},arguments:{name}},'d'.repeat(64),'e'.repeat(64),
        {text:[],omittedContentTypes:[],structuredContent:{name,kind,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,{type}])),required:Object.keys(fields)}}}]);
    return id;
  };
  let expectedAction='',calls=0,created=0;
  let beforeDispatch:(()=>Promise<void>)|undefined;
  const fetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'return-fixture',version:'1'}};
    else if(message.method==='tools/list') {await beforeDispatch?.();result={tools};}
    else {
      calls++;
      assert.equal((await pool.query('select state from pilot_service_actions where id=$1',[expectedAction])).rows[0].state,'running');
      const {name,arguments:args}=message.params.arguments;
      let payload:unknown;
      if(name==='ValidateAddress') payload={original_address:args,analysis:{validation_result:{value:'valid'}}};
      else if(name==='CreateShipment') {
        created++;
        assert.equal(args.address_from.street2,originalBuyer.address!.street2);
        assert.equal(args.address_to.street2,originalSeller.address!.street2);
        assert.equal(args.parcels[0].weight,'43');assert.equal(args.metadata,shippoOperationMetadata(expectedAction));
        assert.equal(args.extra.qr_code_requested,noPrinter);
        payload={...args,object_id:'return_shipment_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,status:'SUCCESS',
          parcels:[{...args.parcels[0],object_id:'return_parcel_fixture'}],
          rates:[{object_id:'return_rate_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',object_created:new Date().toISOString(),test:false,
            shipment:'return_shipment_fixture',carrier_account:'return_carrier_fixture',provider:noPrinter?'USPS':'UPS',servicelevel:{token:noPrinter?'usps_ground_advantage':'ups_ground',name:'Ground'},
            amount:'9.15',currency:'USD',estimated_days:3}]};
      } else {
        assert.equal(name,'GetCarrierAccount');assert.deepEqual(args,{CarrierAccountId:'return_carrier_fixture'});
        payload={object_id:'return_carrier_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,active:true,carrier:noPrinter?'usps':'ups'};
      }
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const connections=new CommerceConnections(service,root,'https://app.tbd.com',undefined,undefined,
    (url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,before,fetch,redact));
  try {
    await pool.query('delete from pilot_operations where exchange_id=$1',[original.id]);
    const order=structuredClone(original),offer=order.offers.at(-1)!;
    order.payment='paid';order.shipping='delivered';order.stage='needs_attention';order.problem='Fixture return';
    order.sellerDroppedAt=new Date().toISOString();order.expiresAt='2020-01-01T00:00:00Z';
    await pool.query('update pilot_exchanges set data=$2 where id=$1',[order.id,order]);
    await command(A,{type:'propose_resolution',remedy:'return',reason:'Return the fixture item'});
    for(const actor of [A,B]) await command(actor,{type:'approve_resolution',binding:(await service.get(actor,order.id)).resolutionBinding});
    const agreed=await repository.get(order.id,A),stale=structuredClone(agreed);
    stale.resolution!.offerDigest='0'.repeat(64);
    await pool.query('update pilot_exchanges set data=$2 where id=$1',[order.id,stale]);
    await assert.rejects(command(B,{type:'propose_shipping_data',connectionId:connection}),/agree to a return/);
    await pool.query('update pilot_exchanges set data=$2 where id=$1',[order.id,agreed]);
    await command(A,{type:'return_packing',packing:{weightOz:43,lengthIn:14,widthIn:9,heightIn:7,packed:true,canPrint:!noPrinter}});
    await command(A,{type:'research_area',postcode:'10001'});
    const research=await service.research.request(A,order.id,{kind:'nearby'});
    assert.equal(research.state,'pending');assert(research.input.query?.includes('10001'));
    await command(B,{type:'propose_shipping_data',connectionId:connection});
    const consent=(await service.get(A,order.id)).shippingData!;
    assert.equal(consent.purpose,'free_return_shipping_rates_only');
    for(const actor of [A,B]) await command(actor,{type:'decide_shipping_data',consentId:consent.id,consentDigest:consent.digest,
      approve:true,acknowledgeServiceAccountAccess:true});
    const validationDescription=await describe('ValidateAddress','read',Object.fromEntries(Object.keys(shippoAddressArguments(originalBuyer.address!)).map(key=>[key,'string'])));
    const creationDescription=await describe('CreateShipment','write',{address_from:'object',address_to:'object',parcels:'array',metadata:'string',async:'boolean',extra:'object'});
    const carrierDescription=await describe('GetCarrierAccount','read',{CarrierAccountId:'string'});
    const rateInput=async()=>({action:'prepare_shipping_rates',exchangeId:order.id,revision:await revision(),connectionId:connection,
      consentId:consent.id,descriptionActionId:creationDescription});
    await assert.rejects(prepareShippingRates(service,B,randomUUID(),await rateInput()),/Validate both/);
    for(const addressRole of ['buyer','seller']) {
      const action=await prepareShippingValidation(service,B,randomUUID(),{...await rateInput(),action:'prepare_shipping_validation',descriptionActionId:validationDescription,addressRole});
      expectedAction=action.id;
      assert.equal((await connections.decideAction(B,action.id,action.digest,true,'free_address_validation')).result?.structuredContent?.addressValidation,'valid');
    }
    const rate=await prepareShippingRates(service,B,randomUUID(),await rateInput());expectedAction=rate.id;
    assert.equal((await connections.decideAction(B,rate.id,rate.digest,true,'free_shipping_rates')).state,'returned');
    assert.equal(created,1);assert.equal((await prepareShippingRates(service,B,randomUUID(),await rateInput())).id,rate.id);
    const option=await prepareShippingOption(service,B,randomUUID(),{action:'prepare_shipping_option',exchangeId:order.id,revision:await revision(),
      rateActionId:rate.id,rateId:'return_rate_fixture',descriptionActionId:carrierDescription});expectedAction=option.id;
    assert.equal((await connections.decideAction(B,option.id,option.digest,true,'free_shipping_option')).state,'returned');
    for(const actor of [A,B]) {
      const shared=await returnShippingOptions(service,actor,order.id);
      assert.equal(shared.length,1);assert.equal(shared[0]!.carrierActionId,option.id);assert.equal(shared[0]!.rate.amount,915);
      assert(!JSON.stringify(shared).includes('CANARY'));
      const model=await service.invoke({userId:actor,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:order.id});
      assert(JSON.stringify(model).includes(option.id));assert(!JSON.stringify(model).includes('CANARY'));
    }
    const sourceId=randomUUID();
    await pool.query("update pilot_research set state='ready',result=$2 where id=$1",[research.id,
      {sources:[{id:sourceId,url:noPrinter?uspsLocationUrl:upsLocationUrl,title:'Official location',description:'Public source'}],checkedAt:new Date().toISOString(),verifiedForFulfillment:false}]);
    const dropoffInput=async()=>({action:'verify_dropoff',exchangeId:order.id,revision:await revision(),carrierActionId:option.id,researchId:research.id,sourceId});
    const verify:Parameters<typeof verifyDropoff>[3]=request=>verifyPublicDropoff(request,()=>async()=>new Response(noPrinter?uspsLocationHtml():upsLocationHtml()));
    await assert.rejects(verifyDropoff(service,B,await dropoffInput(),verify),/other participant/);
    const location=await verifyDropoff(service,A,await dropoffInput(),verify);
    assert.equal(location.dropoff.carrier,noPrinter?'USPS':'UPS');assert.equal(location.dropoff.artifact,noPrinter?'label_qr':'pdf');
    assert.equal((await service.get(A,order.id)).verifiedDropoff?.id,location.id);
    assert.equal((await service.get(B,order.id)).verifiedDropoff,null);
    // The actual buyer agent prepares a private exact return quote. Sharing
    // is a separate human action and never selects a payer or queues postage.
    const input=async()=>({action:'prepare_connected_return',exchangeId:order.id,revision:await revision(),dropoffId:location.id});
    await assert.rejects(prepareConnectedReturn(service,B,randomUUID(),await input()),/other participant/);
    const turn={userId:A,runId:randomUUID(),requestMessageId:randomUUID()};
    const draft=await service.invoke(turn,await input()) as NonNullable<Awaited<ReturnType<typeof prepareConnectedReturn>>>;
    assert.equal(draft.funding,'seller_absorbed');assert.equal(draft.quote.shippingAmount,915);
    assert.equal(draft.quote.artifact,noPrinter?'label_qr':'pdf');
    assert.equal((await service.get(B,order.id)).connectedReturnDraft,null);
    assert.equal((await service.get(B,order.id)).returnPlan!.quote,null);
    assert.equal((await prepareConnectedReturn(service,A,turn.requestMessageId,await input()))!.id,draft.id);
    await assert.rejects(service.invoke(turn,{...await input(),shippingAmount:1}));
    const share={type:'share_connected_return',draftId:draft.id,draftDigest:draft.digest};
    await assert.rejects(command(B,share),/other participant/);
    await assert.rejects(command(A,{...share,draftDigest:'f'.repeat(64)}),/changed or expired/);
    const privateDraft=await repository.privateInput(await repository.get(order.id,A),A);
    await repository.transaction(sql=>repository.savePrivate(sql,order,A,{...privateDraft,
      connectedReturnDraft:{...privateDraft.connectedReturnDraft!,expiresAt:new Date(Date.now()-1000).toISOString()}}));
    await assert.rejects(command(A,share),/changed or expired/);
    await repository.transaction(sql=>repository.savePrivate(sql,order,A,privateDraft));
    await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);
    assert.equal((await service.get(A,order.id)).connectedReturnDraft?.state,'stale');
    await assert.rejects(command(A,share));
    await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
    const conflictingRefund=randomUUID();
    await pool.query("insert into pilot_operations(id,exchange_id,mode,kind,version) values($1,$2,$3,'refund',$4)",
      [conflictingRefund,order.id,order.mode,offer.version]);
    await assert.rejects(command(A,share),/existing purchase or refund/);
    await pool.query('delete from pilot_operations where id=$1',[conflictingRefund]);
    const key=randomUUID(),beforeShare=await revision();
    await service.command(A,order.id,key,beforeShare,share);await service.command(A,order.id,key,beforeShare,share);
    const shared=await service.get(B,order.id);
    assert.equal(shared.returnPlan!.version,1);assert.deepEqual(shared.returnPlan!.quote,draft.quote);
    assert.equal(shared.returnPlan!.funding,'seller_absorbed');assert.deepEqual(shared.returnPlan!.approvals,[]);
    assert(shared.returnBinding);
    for(const actor of [A,B]) {
      await assert.rejects(command(actor,{type:'approve_return',binding:{}}),/stale/);
      const model=JSON.stringify(await service.invoke({userId:actor,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:order.id}));
      assert(model.includes('owner_return_postage_approval'));
      for(const secret of ['PRIVATE_ACCOUNT_CANARY','PRIVATE_ADDRESS_CANARY',root]) assert(!model.includes(secret));
      assert(!JSON.stringify((await service.get(actor,order.id)).privateInput).includes('connectedReturn'));
    }
    assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[order.id])).rows[0].n,0);
    await checkConnectedReturnWorker(service,await repository.get(order.id,A),root,tools,describe);
    // Changed private input invalidates a newly prepared draft before sharing.
    const next=await prepareConnectedReturn(service,A,randomUUID(),await input());assert(next);
    // An old outbound carrier receipt cannot become reverse-shipment evidence.
    const outbound=(await pool.query("select id from pilot_service_actions where exchange_id=$1 and invocation ? 'shippingOption' and id<>$2 order by created_at limit 1",[order.id,option.id])).rows[0];
    if(outbound) await assert.rejects(verifyDropoff(service,A,{...await dropoffInput(),carrierActionId:outbound.id},verify));
    await command(A,{type:'return_packing',packing:{weightOz:44,lengthIn:14,widthIn:9,heightIn:7,packed:true,canPrint:true}});
    assert.equal((await service.get(A,order.id)).verifiedDropoff?.state,'stale');
    assert.equal((await service.get(A,order.id)).connectedReturnDraft?.state,'stale');
    await assert.rejects(command(A,{type:'share_connected_return',draftId:next.id,draftDigest:next.digest}),/changed or expired/);
    assert.deepEqual(await returnShippingOptions(service,A,order.id),[]);
    assert.equal(created,1);assert.equal(calls,4);
    assert.equal(digest((await repository.get(order.id,A)).offers.at(-1)),digest(offer),'Return planning cannot replace the paid sale');
    process.stdout.write(`PASS: separate return consent, original account, reversed private SDK validation/rates, buyer packing/research/${noPrinter?'USPS retail QR':'UPS PDF'} drop-off, safe shared rate evidence, private exact quote preparation, buyer-only sharing, replay/privacy/input guards, seller-absorbed funding and no spending before approval, stale outbound rejection and input invalidation; synthetic providers only.\n`);
  } finally {
    await pool.query('delete from pilot_operations where exchange_id=$1',[original.id]);
    await pool.query('insert into pilot_operations select * from jsonb_populate_recordset(null::pilot_operations,$1::jsonb)',[JSON.stringify(originalOperations)]);
    await repository.transaction(async sql=>{
      await sql.query('update pilot_exchanges set data=$2,revision=$3 where id=$1',[original.id,original,original.revision]);
      await repository.savePrivate(sql,original,A,originalBuyer);await repository.savePrivate(sql,original,B,originalSeller);
    });
  }
}
