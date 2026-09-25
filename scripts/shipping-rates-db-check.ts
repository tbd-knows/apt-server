import { checkConnectedWorker } from './connected-shipping-worker-check.js';
import { checkConnectedReturn } from './connected-return-check.js';
import { ConnectedShippingRead } from '../src/commerce/connected-shipping-read.js';
import { digest } from '../src/commerce/domain.js';
import { requireConnectedOffer } from '../src/commerce/connected-offer.js';
/** Real disposable Postgres; no model, third-party disclosure or purchase. */
import assert from 'node:assert/strict';
import { prepareConnectedOffer } from '../src/commerce/connected-offer.js';
import { verifyDropoff } from '../src/commerce/verified-dropoff.js';
import { verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { locationFixture,locationUrl } from '../test/fixtures/public-dropoff.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { requireShippingDataConsent } from '../src/commerce/shipping-consent.js';
import { prepareShippingValidation } from '../src/commerce/shipping-validation.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { ConnectionSecrets } from '../src/commerce/connection-secrets.js';
import { executeMcp } from '../src/commerce/mcp-execution.js';
import { shippoAddressArguments } from '../src/commerce/shippo-evidence.js';
import { prepareShippingOption } from '../src/commerce/shipping-option.js';
import { prepareShippingRates } from '../src/commerce/shipping-rates.js';
import { shippoOperationMetadata } from '../src/commerce/shippo-evidence.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const url = process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const pool = new pg.Pool({ connectionString: url });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const repository = new CommerceRepository(pool);
let now = new Date();
const economics={taxAmount:0,taxTreatment:'Fixture tax treatment',subsidy:'Fixture processing subsidy'};
const service = () => new CommerceService(repository,[A,B],'test',()=>now,economics);
const command = async (actor:string,id:string,input:unknown) => {
  const view = await service().get(actor,id);
  return service().command(actor,id,randomUUID(),view.revision,input);
};
try {
  const draft = await service().create(A,randomUUID(), { request: { item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Good' }, privateBudget:937123 });
  await command(A,draft.id,{type:'share_request',requestDigest:draft.requestDigest});
  const photo = randomUUID();
  await pool.query(`insert into pilot_assets(id,owner_id,exchange_id,kind,storage_path,mime,bytes,state)
    values($1,$2,$3,'photo',$4,'image/jpeg',100,'ready')`,[photo,B,draft.id,`fixture/${photo}`]);
  await command(B,draft.id,{type:'share_item',item:{itemId:randomUUID(),description:'White shoes',size:'10',sizingSystem:'US men',condition:'Good',defects:'',photoIds:[photo],sellerAmount:5000}});
  const address = {name:'Fixture',street1:'123 Test Street',street2:'',city:'New York',state:'NY',zip:'10001',country:'US',phone:'+12125550100'};
  await command(A,draft.id,{type:'address',address:{...address,street2:'BUYER_PRIVATE_ADDRESS_CANARY'}});
  await command(B,draft.id,{type:'address',address:{...address,street2:'SELLER_PRIVATE_ADDRESS_CANARY'}});
  await command(B,draft.id,{type:'packing',packing:{weightOz:32,lengthIn:12,widthIn:8,heightIn:6,packed:true,canPrint:true}});
  await command(B,draft.id,{type:'research_area',postcode:'10001'});
  const research = randomUUID(), connection = randomUUID(), generation = randomUUID(), endpoint = 'https://mcp.shippo.com/';
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,approved_at,result)
    values($1,$2,$3,'test','inspect_mcp',$4,$5,'ready',now(),$6)`,[research,draft.id,B,{url:endpoint,addressVersion:0},randomUUID(),{sources:[],mcp:{status:'authorization_required'}}]);
  await pool.query(`insert into pilot_connections(id,exchange_id,owner_id,research_id,mode,endpoint,state,generation)
    values($1,$2,$3,$4,'test',$5,'connected',$6)`,[connection,draft.id,B,research,endpoint,generation]);
  const propose = () => command(B,draft.id,{type:'propose_shipping_data',connectionId:connection});
  const decide = async (actor:string,approve=true,acknowledge=true) => {
    const view = await service().get(actor,draft.id), plan = view.shippingData!;
    return command(actor,draft.id,{type:'decide_shipping_data',consentId:plan.id,consentDigest:plan.digest,approve,
      acknowledgeServiceAccountAccess:acknowledge});
  };
  const resolve = (consentId:string) => repository.transaction(async sql => {
    const e = await repository.get(draft.id,B,sql,true);
    return requireShippingDataConsent(service(),sql,e,connection,consentId,now);
  });
  await assert.rejects(command(A,draft.id,{type:'propose_shipping_data',connectionId:connection}),/other participant/);
  await assert.rejects(command(B,draft.id,{type:'propose_shipping_data',connectionId:randomUUID()}),/Connect and inspect/);
  // Real owner bridge surface can only draft the proposal, never approve it.
  let view = await service().get(B,draft.id);
  const context = {userId:B,runId:randomUUID(),requestMessageId:randomUUID()};
  await service().invoke(context,{action:'prepare_action',exchangeId:draft.id,revision:view.revision,
    command:{type:'propose_shipping_data',connectionId:connection},explanation:'Review a possible service for free shipping rates.'});
  view = await service().get(B,draft.id);
  assert.equal(view.shippingData,null);
  const consentPreparation = view.privateInput.agentAction!;
  await command(B,draft.id,{type:'approve_agent_action',actionId:consentPreparation.id,actionDigest:consentPreparation.digest});
  const initial = (await service().get(B,draft.id)).shippingData!;
  assert.equal(initial.approvalCount,0);
  assert.equal(initial.purpose,'free_shipping_rates_only');
  await assert.rejects(resolve(initial.id),/Both owners/);
  await assert.rejects(decide(A,true,false),/Confirm that the service/);
  await assert.rejects(command(A,draft.id,{type:'decide_shipping_data',consentId:initial.id,consentDigest:'f'.repeat(64),approve:true,acknowledgeServiceAccountAccess:true}),/changed/);
  await assert.rejects(service().invoke(context,{action:'prepare_action',exchangeId:draft.id,revision:view.revision,
    command:{type:'decide_shipping_data',consentId:initial.id,consentDigest:initial.digest,approve:true},explanation:'Approve as a model'}));
  await decide(A);
  await assert.rejects(resolve(initial.id),/Both owners/);
  await decide(A); // Same owner cannot provide both approvals.
  assert.equal((await service().get(A,draft.id)).shippingData?.approvalCount,1);
  await decide(B);
  assert.equal((await new CommerceService(repository,[A,B],'test',()=>now).get(B,draft.id)).shippingData?.state,'approved');
  const privateInputs = await resolve(initial.id);
  assert.equal(privateInputs.destination.street2,'BUYER_PRIVATE_ADDRESS_CANARY');
  assert.equal(privateInputs.origin.street2,'SELLER_PRIVATE_ADDRESS_CANARY');
  await assert.rejects(repository.transaction(async sql => {
    const e = await repository.get(draft.id,B,sql,true);
    return requireShippingDataConsent(new CommerceService(repository,[A,B],'live'),sql,e,connection,initial.id,now);
  }),/pilot mode/);
  for (const actor of [A,B]) {
    const model = await service().invoke({userId:actor,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:draft.id});
    assert(!JSON.stringify(model).includes('PRIVATE_ADDRESS_CANARY'));
    const peerView = await service().get(actor,draft.id);
    assert(!JSON.stringify(peerView).includes(actor===A?'SELLER_PRIVATE_ADDRESS_CANARY':'BUYER_PRIVATE_ADDRESS_CANARY'));
    assert(!JSON.stringify(peerView.shippingData).includes(connection));
  }
  // Authenticated tool/operation shapes below are fixtures. Production account
  // compatibility remains unverified; every call still uses the real MCP SDK.
  const read={name:'shippo_read_execute_tool',description:'Read',inputSchema:{type:'object',properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments']}};
  const write={...read,name:'shippo_write_execute_tool',description:'Write'};
  const describe=async(name:string,kind:string,fields:Record<string,string>)=>{
    const id=randomUUID();
    await pool.query(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,endpoint,
      invocation,explanation,digest,call_digest,state,result,expires_at)
      values($1,$2,$3,$4,'test',$5,1,$6,$7,$8,'fixture description',$9,$10,'returned',$11,now()+interval '1 hour')`,
      [id,draft.id,B,connection,randomUUID(),generation,endpoint,{tool:{name:'shippo_describe_tool',description:'Describe',inputSchema:{type:'object'}},arguments:{name}},
        'd'.repeat(64),'e'.repeat(64),{text:[],omittedContentTypes:[],structuredContent:{name,kind,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,{type}])),required:Object.keys(fields)}}}]);
    return id;
  };
  const validationDescription=await describe('ValidateAddress','read',Object.fromEntries(Object.keys(shippoAddressArguments(privateInputs.destination)).map(key=>[key,'string'])));
  const creationDescription=await describe('CreateShipment','write',{address_from:'object',address_to:'object',parcels:'array',metadata:'string',async:'boolean',extra:'object'});
  const retrievalDescription=await describe('GetShipment','read',{ShipmentId:'string'});
  const carrierDescription=await describe('GetCarrierAccount','read',{CarrierAccountId:'string'});
  const root='r'.repeat(32),sealed=new ConnectionSecrets(root).seal(JSON.stringify([connection,B,draft.id,'test',endpoint]),{tokens:{access_token:'TOKEN_CANARY',token_type:'Bearer'}});
  await pool.query("update pilot_connections set credentials=$2,inspection=$3,access_expires_at=now()+interval '1 hour' where id=$1",
    [connection,sealed,{status:'inspected',transport:'streamable_http',tools:[read,write],authority:'untrusted_capabilities_only'}]);
  let expectedAction='',creationCalls=0,retrievalCalls=0,failAfterSend=false,foreignAccount=false,carrierActive=true,carrierCalls=0;
  let onList:(()=>Promise<void>)|undefined;
  let originalCreation:Record<string,any>={};
  const fetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(message.method==='tools/list') {await onList?.();result={tools:[read,write]};}
    else {
      assert.equal((await pool.query('select state from pilot_service_actions where id=$1',[expectedAction])).rows[0].state,'running');
      const args=message.params.arguments.arguments,operation=message.params.arguments.name;
      let payload:unknown;
      if(operation==='ValidateAddress') payload={original_address:args,analysis:{validation_result:{value:'valid'}}};
      else if(operation==='CreateShipment') {
        creationCalls++;assert.equal(message.params.name,write.name);
        assert.equal(args.address_from.street2,'SELLER_PRIVATE_ADDRESS_CANARY');assert.equal(args.address_to.street2,'BUYER_PRIVATE_ADDRESS_CANARY');
        assert.equal(args.parcels[0].weight,'32');assert.equal(args.metadata,shippoOperationMetadata(expectedAction));
        originalCreation=args;
        if(failAfterSend) throw new Error('PRIVATE_REMOTE_FAILURE');
        payload={...args,object_id:'shipment_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,status:'WAITING',rates:[]};
      } else if(operation==='GetCarrierAccount') {
        carrierCalls++;assert.equal(message.params.name,read.name);assert.deepEqual(args,{CarrierAccountId:'carrier_fixture'});
        payload={object_id:'carrier_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,active:carrierActive,carrier:'fedex',parameters:{password:'PRIVATE_CARRIER_SECRET_CANARY'}};
      } else {
        assert.equal(operation,'GetShipment');assert.equal(message.params.name,read.name);assert.deepEqual(args,{ShipmentId:'shipment_fixture'});retrievalCalls++;
        payload={...originalCreation,object_id:'shipment_fixture',object_owner:foreignAccount?'ANOTHER_ACCOUNT':'PRIVATE_ACCOUNT_CANARY',test:false,status:'SUCCESS',
          parcels:[{...originalCreation.parcels[0],object_id:'parcel_fixture'}],
          rates:[{object_id:'rate_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',object_created:new Date().toISOString(),test:false,
            shipment:'shipment_fixture',carrier_account:'carrier_fixture',provider:'FedEx',servicelevel:{token:'fedex_ground',name:'Ground'},
            amount:'8.05',currency:'USD',estimated_days:3}]};
      }
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{secret:'TOKEN_CANARY'},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const connections=new CommerceConnections(service(),root,'https://app.tbd.com',undefined,undefined,
    (url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,before,fetch,redact));
  const input=async(consentId=initial.id)=>({action:'prepare_shipping_rates' as const,exchangeId:draft.id,revision:(await service().get(B,draft.id)).revision,
    connectionId:connection,consentId,descriptionActionId:creationDescription});
  const validate=async(consentId:string,addressRole:'buyer'|'seller')=>{
    const current=await input(consentId);
    const action=await prepareShippingValidation(service(),B,randomUUID(),{...current,action:'prepare_shipping_validation',descriptionActionId:validationDescription,addressRole});
    expectedAction=action.id;
    assert.equal((await connections.decideAction(B,action.id,action.digest,true,'free_address_validation')).result?.structuredContent?.addressValidation,'valid');
  };
  await assert.rejects(prepareShippingRates(service(),B,randomUUID(),await input()),/Validate both/);
  await validate(initial.id,'buyer');await assert.rejects(prepareShippingRates(service(),B,randomUUID(),await input()),/Validate both/);
  await validate(initial.id,'seller');
  await assert.rejects(prepareShippingRates(service(),A,randomUUID(),await input()),/other participant/);
  await assert.rejects(prepareShippingRates(service(),B,randomUUID(),{...await input(),arguments:{test:true}}));
  await assert.rejects(prepareShippingRates(service(),B,randomUUID(),{...await input(),descriptionActionId:validationDescription}),/unsupported format/);
  const stale=await prepareShippingRates(service(),B,randomUUID(),await input());
  await pool.query("update pilot_service_actions set expires_at=now()-interval '1 second' where id=$1",[stale.id]);
  const prepared=await service().invoke(context,await input()) as Awaited<ReturnType<typeof prepareShippingRates>>;
  assert.notEqual(prepared.id,stale.id);
  assert.equal((await pool.query('select state from pilot_service_actions where id=$1',[stale.id])).rows[0].state,'expired');
  assert.equal(prepared.purpose,'free_shipping_rates');assert(!JSON.stringify(prepared).includes('CANARY'));
  assert.equal((await prepareShippingRates(service(),B,randomUUID(),await input())).id,prepared.id,'new turn cannot create another shipment');
  await assert.rejects(connections.decideAction(B,prepared.id,prepared.digest,true,'free_address_validation'),/correct service action purpose/);
  expectedAction=prepared.id;
  const pending=await connections.decideAction(B,prepared.id,prepared.digest,true,'free_shipping_rates');
  assert.equal(pending.state,'returned');assert.equal(creationCalls,1);
  assert.equal((pending.result!.structuredContent!.shippingRates as any).shipment.state,'pending');
  assert(!JSON.stringify(pending).includes('CANARY'));
  await connections.decideAction(B,prepared.id,prepared.digest,true,'free_shipping_rates');assert.equal(creationCalls,1);
  const retrieval={...await input(),descriptionActionId:retrievalDescription,sourceActionId:prepared.id};
  const poll=await prepareShippingRates(service(),B,randomUUID(),retrieval);expectedAction=poll.id;
  const returned=await connections.decideAction(B,poll.id,poll.digest,true,'free_shipping_rates');
  assert.equal(returned.state,'returned');assert.equal(retrievalCalls,1);
  const rates=returned.result!.structuredContent!.shippingRates as any;
  assert.equal(rates.providerMode,'live','test commerce must never claim hosted MCP test rates');
  assert.equal(rates.shipment.state,'rated');assert.equal(rates.shipment.rates[0].amount,805);
  assert(!JSON.stringify(returned).includes('CANARY'));
  assert.equal((await prepareShippingRates(service(),B,randomUUID(),retrieval)).id,poll.id);
  await assert.rejects(prepareShippingRates(service(),B,randomUUID(),{...retrieval,sourceActionId:poll.id}),/pending shipment/);
  const stored=(await pool.query('select result from pilot_service_actions where id=$1',[poll.id])).rows[0].result;
  assert(!JSON.stringify(stored).includes('PRIVATE_ADDRESS_CANARY'));assert(!JSON.stringify(stored).includes('TOKEN_CANARY'));
  for(const actor of [A,B]) {
    const state=await service().invoke({userId:actor,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:draft.id});
    for(const secret of ['PRIVATE_ADDRESS_CANARY','PRIVATE_ACCOUNT_CANARY','TOKEN_CANARY']) assert(!JSON.stringify(state).includes(secret));
  }
  const optionInput={action:'prepare_shipping_option' as const,exchangeId:draft.id,revision:(await service().get(B,draft.id)).revision,
    rateActionId:poll.id,rateId:'rate_fixture',descriptionActionId:carrierDescription};
  await assert.rejects(prepareShippingOption(service(),A,randomUUID(),optionInput),/other participant/);
  await assert.rejects(prepareShippingOption(service(),B,randomUUID(),{...optionInput,rateId:'invented'}),/actual returned rate/);
  await assert.rejects(prepareShippingOption(service(),B,randomUUID(),{...optionInput,descriptionActionId:creationDescription}),/unsupported format/);
  await assert.rejects(prepareShippingOption(service(),B,randomUUID(),{...optionInput,CarrierAccountId:'invented'}));
  const option=await prepareShippingOption(service(),B,randomUUID(),optionInput);expectedAction=option.id;
  assert.equal(option.purpose,'free_shipping_option');assert(!JSON.stringify(option).includes('CANARY'));
  await assert.rejects(connections.decideAction(B,option.id,option.digest,true,'free_shipping_rates'),/correct service action purpose/);
  const checked=await connections.decideAction(B,option.id,option.digest,true,'free_shipping_option');
  assert.equal(checked.state,'returned');assert.equal(carrierCalls,1);
  assert.deepEqual(checked.result?.structuredContent?.shippingOption,{rateId:'rate_fixture',carrierAccountId:'carrier_fixture',carrierToken:'fedex',sourceActionId:poll.id,providerMode:'live'});
  assert(!JSON.stringify(checked).includes('CANARY'));
  assert(!JSON.stringify((await pool.query('select result from pilot_service_actions where id=$1',[option.id])).rows).includes('CANARY'));
  await connections.decideAction(B,option.id,option.digest,true,'free_shipping_option');assert.equal(carrierCalls,1);
  assert.equal((await prepareShippingOption(service(),B,randomUUID(),optionInput)).id,option.id);
  // Public location verification uses the real parser with synthetic HTTP data.
  // No carrier account credentials or private address leave the DB in this step.
  const nearby=randomUUID(),sourceId=randomUUID();
  const researchInput=async()=>({query:'fixture public search',addressVersion:(await service().get(B,draft.id)).privateInput.discoveryVersion});
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,result)
    values($1,$2,$3,'test','nearby',$4,$5,'ready',$6)`,[nearby,draft.id,B,await researchInput(),randomUUID(),
    {sources:[{id:sourceId,url:locationUrl,title:'Official location',description:'Public source'}],checkedAt:new Date().toISOString(),verifiedForFulfillment:false}]);
  let publicCalls=0;
  const publicVerifier:Parameters<typeof verifyDropoff>[3]=request=>{
    assert(!JSON.stringify(request).includes('CANARY'));assert.deepEqual(Object.keys(request).sort(),['carrierToken','packing','serviceToken','sourceUrl']);
    return verifyPublicDropoff(request,(url,format)=>async()=>{publicCalls++;
      assert(url===locationUrl || url==='https://local.fedex.com/en/search?entityId=FIXTURE');
      return new Response(format==='html'?'Yext["EntityId"] = "FIXTURE"':JSON.stringify(locationFixture()));
    });
  };
  const dropoffInput=async()=>({action:'verify_dropoff' as const,exchangeId:draft.id,revision:(await service().get(B,draft.id)).revision,
    carrierActionId:option.id,researchId:nearby,sourceId});
  await assert.rejects(verifyDropoff(service(),A,await dropoffInput(),publicVerifier),/other participant/);
  await assert.rejects(verifyDropoff(service(),B,{...await dropoffInput(),sourceId:randomUUID()},publicVerifier),/observed official location/);
  await assert.rejects(service().invoke(context,{...await dropoffInput(),sourceUrl:locationUrl}));
  assert.equal(publicCalls,0);
  // Human input can change during the network call: no lock is held, and the
  // second transaction refuses to persist evidence for the old discovery area.
  await assert.rejects(verifyDropoff(service(),B,await dropoffInput(),async request=>{
    const result=await publicVerifier(request);
    await command(B,draft.id,{type:'research_area',postcode:'10002'});
    return result;
  }),/exchange changed/);
  assert.equal((await service().get(B,draft.id)).verifiedDropoff,null);
  await assert.rejects(verifyDropoff(service(),B,await dropoffInput(),publicVerifier),/current discovery area/);
  await pool.query('update pilot_research set input=$2 where id=$1',[nearby,await researchInput()]);
  const location=await verifyDropoff(service(),B,await dropoffInput(),publicVerifier);
  assert.equal(location.state,'current');assert.equal(location.scope,'location_compatibility_only');assert.equal(publicCalls,4);
  assert.equal((await verifyDropoff(service(),B,await dropoffInput(),publicVerifier)).id,location.id);assert.equal(publicCalls,4);
  await pool.query("update pilot_connections set access_expires_at=now()-interval '1 second' where id=$1",[connection]);
  assert.equal((await service().get(B,draft.id)).verifiedDropoff?.state,'stale');
  await assert.rejects(verifyDropoff(service(),B,await dropoffInput(),publicVerifier),/Recheck the connected service access/);
  assert.equal(publicCalls,4);
  await pool.query("update pilot_connections set access_expires_at=now()+interval '1 hour' where id=$1",[connection]);
  const persisted=await service().get(B,draft.id);
  assert.equal(persisted.verifiedDropoff?.id,location.id);
  assert.equal((await service().get(A,draft.id)).verifiedDropoff,null);
  const sellerModel=await service().invoke(context,{action:'state',exchangeId:draft.id});
  assert(JSON.stringify(sellerModel).includes(location.id));assert(!JSON.stringify(sellerModel).includes('CANARY'));
  const privateRecord=(await repository.privateInput(await repository.get(draft.id,B),B)).verifiedDropoff!;
  assert(!JSON.stringify(sellerModel).includes(privateRecord.binding));
  const offerInput=async()=>({action:'prepare_connected_offer' as const,exchangeId:draft.id,revision:(await service().get(B,draft.id)).revision,dropoffId:location.id});
  await assert.rejects(prepareConnectedOffer(service(),A,randomUUID(),await offerInput()),/other participant/);
  await assert.rejects(prepareConnectedOffer(new CommerceService(repository,[A,B],'test'),B,randomUUID(),await offerInput()),/tax treatment/);
  await assert.rejects(service().invoke(context,{...await offerInput(),shippingAmount:1}));
  await assert.rejects(service().invoke(context,{action:'share_connected_offer',exchangeId:draft.id,draftId:randomUUID(),draftDigest:'a'.repeat(64)}));
  const offerContext={...context,requestMessageId:randomUUID()};
  let preparedOffer=await service().invoke(offerContext,await offerInput()) as NonNullable<Awaited<ReturnType<typeof prepareConnectedOffer>>>;
  assert.equal(preparedOffer.offer.postageFunding,'seller_reimbursed');assert.equal(preparedOffer.offer.buyerTotal,5805);
  assert.equal(preparedOffer.settlement.sellerTransferAmount,5805);assert.equal(preparedOffer.settlement.postageReimbursement,805);
  assert.equal(preparedOffer.offer.connectedShipping?.providerMode,'live');
  assert(Date.parse(preparedOffer.offer.expiresAt)>Date.now()+31*60_000);
  assert(Date.parse(preparedOffer.expiresAt)<=Date.parse(location.expiresAt));
  assert.equal((await service().get(A,draft.id)).offer,null);assert.equal((await service().get(A,draft.id)).connectedOfferDraft,null);
  assert.equal((await prepareConnectedOffer(service(),B,offerContext.requestMessageId,await offerInput()))?.id,preparedOffer.id);
  assert.equal((await prepareConnectedOffer(service(),B,randomUUID(),await offerInput()))?.id,preparedOffer.id);
  const currentModel=await service().invoke(context,{action:'state',exchangeId:draft.id});
  for(const secret of ['PRIVATE_ACCOUNT_CANARY','PRIVATE_ADDRESS_CANARY',privateRecord.binding]) assert(!JSON.stringify(currentModel).includes(secret));
  assert(!JSON.stringify((await service().get(B,draft.id)).privateInput).includes('connectedShipping'));
  await command(B,draft.id,{type:'message',kind:'question',text:'Confirming the prepared offer.'});
  assert.equal((await service().get(B,draft.id)).connectedOfferDraft?.state,'stale');
  await assert.rejects(command(B,draft.id,{type:'share_connected_offer',draftId:preparedOffer.id,draftDigest:preparedOffer.digest}),/changed or expired/);
  preparedOffer=(await prepareConnectedOffer(service(),B,randomUUID(),await offerInput()))!;
  const publish={type:'share_connected_offer',draftId:preparedOffer.id,draftDigest:preparedOffer.digest};
  await assert.rejects(command(A,draft.id,publish),/other participant/);
  await assert.rejects(command(B,draft.id,{...publish,draftDigest:'f'.repeat(64)}),/changed or expired/);
  await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);
  assert.equal((await service().get(B,draft.id)).connectedOfferDraft?.state,'stale');
  await assert.rejects(command(B,draft.id,publish),/connection changed/);
  await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
  const versionBefore=(await service().get(B,draft.id)).revision,key=randomUUID();
  await service().command(B,draft.id,key,versionBefore,publish);
  await service().command(B,draft.id,key,versionBefore,publish);
  const shared=await service().get(A,draft.id);
  assert.deepEqual(shared.offer,preparedOffer.offer);assert.equal(shared.approvalCount,0);
  assert.equal((await repository.get(draft.id,B)).offers.length,1);
  assert.equal((await service().get(B,draft.id)).connectedOfferDraft,null);
  const privateShipping=(await repository.privateInput(await repository.get(draft.id,B),B)).connectedShipping!['1']!;
  assert.equal(privateShipping.accountOwner,'PRIVATE_ACCOUNT_CANARY');
  assert(!JSON.stringify(shared).includes('PRIVATE_ACCOUNT_CANARY'));
  for(const actor of [A,B]) {
    const view=await service().get(actor,draft.id);
    await assert.rejects(command(actor,draft.id,{type:'approve',binding:view.approval,acknowledgeSellerPostageReimbursement:true}),/connected shipping/);
    await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);
    await assert.rejects(command(actor,draft.id,{type:'approve',binding:view.approval,acknowledgeSellerPostageReimbursement:true,acknowledgeConnectedShipping:true}),/account, item or private/);
    await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
    await command(actor,draft.id,{type:'approve',binding:view.approval,acknowledgeSellerPostageReimbursement:true,acknowledgeConnectedShipping:true});
  }
  await assert.rejects(command(A,draft.id,{type:'checkout'}),/test-mode payment/);
  assert.equal((await service().get(A,draft.id)).payment,'unpaid');
  optionInput.revision=(await service().get(B,draft.id)).revision;
  const expiredSource=structuredClone(stored);expiredSource.structuredContent.shippingRates.shipment.rates[0].expiresAt='2000-01-01T00:00:00Z';
  await pool.query('update pilot_service_actions set result=$2 where id=$1',[poll.id,expiredSource]);
  await assert.rejects(prepareShippingOption(service(),B,randomUUID(),optionInput),/missing or expired/);
  assert.equal((await service().get(B,draft.id)).verifiedDropoff?.state,'stale');
  await pool.query('update pilot_service_actions set result=$2 where id=$1',[poll.id,stored]);
  // Another described check cannot bypass provider active-state verification.
  const secondCarrierDescription=await describe('GetCarrierAccount','read',{CarrierAccountId:'string'});
  const inactive=await prepareShippingOption(service(),B,randomUUID(),{...optionInput,descriptionActionId:secondCarrierDescription});expectedAction=inactive.id;carrierActive=false;
  const inactiveResult=await connections.decideAction(B,inactive.id,inactive.digest,true,'free_shipping_option');
  assert.equal(inactiveResult.state,'returned_error');assert.equal(inactiveResult.result,null);carrierActive=true;
  const plan=async()=>{const next=(await propose()).shippingData!;await decide(A);await decide(B);await validate(next.id,'buyer');await validate(next.id,'seller');return next;};
  // A timeout after send cannot allocate another CreateShipment operation.
  const second=await plan(),uncertain=await prepareShippingRates(service(),B,randomUUID(),await input(second.id));
  expectedAction=uncertain.id;failAfterSend=true;
  assert.equal((await connections.decideAction(B,uncertain.id,uncertain.digest,true,'free_shipping_rates')).state,'uncertain');
  assert.equal((await prepareShippingRates(service(),B,randomUUID(),await input(second.id))).id,uncertain.id);
  assert.equal(creationCalls,2);failAfterSend=false;
  // Consent withdrawal while tools/list is in flight prevents any shipment.
  const third=await plan(),racing=await prepareShippingRates(service(),B,randomUUID(),await input(third.id));
  expectedAction=racing.id;onList=async()=>{await decide(A,false);};
  assert.equal((await connections.decideAction(B,racing.id,racing.digest,true,'free_shipping_rates')).state,'failed');
  assert.equal(creationCalls,2);onList=undefined;
  // Account identity from initial authenticated receipt is pinned for polling.
  const fourth=await plan(),createAgain=await prepareShippingRates(service(),B,randomUUID(),await input(fourth.id));expectedAction=createAgain.id;
  await connections.decideAction(B,createAgain.id,createAgain.digest,true,'free_shipping_rates');
  const foreign=await prepareShippingRates(service(),B,randomUUID(),{...await input(fourth.id),descriptionActionId:retrievalDescription,sourceActionId:createAgain.id});expectedAction=foreign.id;foreignAccount=true;
  const rejected=await connections.decideAction(B,foreign.id,foreign.digest,true,'free_shipping_rates');
  assert.equal(rejected.state,'returned_error');assert.equal(rejected.result,null);
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[draft.id])).rows[0].n,0);
  const final=await service().get(B,draft.id);assert.equal(final.verifiedDropoff?.state,'stale');assert.equal(final.payment,'unpaid');assert.equal(final.shipping,'none');assert.equal(final.offer?.postageFunding,'seller_reimbursed');
  // Move this disposable fixture (never a real exchange) to live commerce to
  // prove the unfinished execution gate refuses even fully approved live terms.
  const liveExchange=await repository.get(draft.id,B);liveExchange.mode='live';
  await pool.query('update pilot_exchanges set mode=$2,data=$3 where id=$1',[draft.id,'live',liveExchange]);
  await pool.query('update pilot_connections set mode=$2 where id=$1',[connection,'live']);
  const liveService=new CommerceService(repository,[A,B],'live',()=>new Date(),economics);
  const liveView=await liveService.get(A,draft.id);
  await assert.rejects(liveService.command(A,draft.id,randomUUID(),liveView.revision,{type:'checkout'}),/postage execution must be available/);
  assert.equal((await liveService.get(A,draft.id)).payment,'unpaid');
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[draft.id])).rows[0].n,0);
  // Read-only connected reconciliation: actual MCP SDK, synthetic transport.
  // No real postage or Stripe purchase occurs in this disposable live fixture.
  const descriptions:Record<string,Record<string,string>>={GetRate:{RateId:'string'},GetTransaction:{TransactionId:'string'},
    GetTrack:{Carrier:'string',TrackingNumber:'string'},GetRefund:{RefundId:'string'}};
  for(const [name,fields] of Object.entries(descriptions)) await describe(name,'read',fields);
  await pool.query("update pilot_service_actions set mode='live' where connection_id=$1",[connection]);
  await pool.query('update pilot_connections set credentials=$2 where id=$1',[connection,
    new ConnectionSecrets(root).seal(JSON.stringify([connection,B,draft.id,'live',endpoint]),{tokens:{access_token:'TOKEN_CANARY',token_type:'Bearer'}})]);
  let readCalls=0,price='8.05',account='PRIVATE_ACCOUNT_CANARY',trackStatus='TRANSIT';
  let beforeRead:(()=>Promise<void>)|undefined,afterRead:(()=>Promise<void>)|undefined;
  const labelOp=randomUUID(),refundOp=randomUUID();
  const readFetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'read-fixture',version:'1'}};
    else if(message.method==='tools/list') {await beforeRead?.();result={tools:[read,write]};}
    else {
      readCalls++;assert.equal(message.params.name,read.name);
      const {name,arguments:args}=message.params.arguments;
      assert(!JSON.stringify(args).includes('CANARY'));
      let payload:unknown;
      if(name==='GetRate') {assert.deepEqual(args,{RateId:'rate_fixture'});payload={object_id:'rate_fixture',object_owner:account,
        object_created:new Date().toISOString(),test:false,shipment:'shipment_fixture',carrier_account:'carrier_fixture',provider:'FedEx',
        servicelevel:{token:'fedex_ground',name:'Ground'},amount:price,currency:'USD',estimated_days:3};}
      else if(name==='GetCarrierAccount') {assert.deepEqual(args,{CarrierAccountId:'carrier_fixture'});payload={object_id:'carrier_fixture',object_owner:account,test:false,active:true,carrier:'fedex'};}
      else if(name==='GetTransaction') {assert.deepEqual(args,{TransactionId:'transaction_fixture'});payload={object_id:'transaction_fixture',object_owner:account,test:false,
        metadata:shippoOperationMetadata(labelOp),rate:'rate_fixture',parcel:'parcel_fixture',status:'SUCCESS',tracking_number:'TRACKING_FIXTURE',
        label_file_type:'PDF',label_url:'https://deliver.goshippo.com/label.pdf?signature=PRIVATE_ARTIFACT_CANARY'};}
      else if(name==='GetTrack') {assert.deepEqual(args,{Carrier:'fedex',TrackingNumber:'TRACKING_FIXTURE'});payload={carrier:'fedex',tracking_number:'TRACKING_FIXTURE',
        transaction:'transaction_fixture',tracking_status:{object_id:'event_fixture',object_updated:new Date().toISOString(),status_date:new Date().toISOString(),status:trackStatus}};}
      else {assert.equal(name,'GetRefund');assert.deepEqual(args,{RefundId:'refund_fixture'});payload={object_id:'refund_fixture',object_owner:account,test:false,transaction:'transaction_fixture',status:'PENDING'};}
      await afterRead?.();
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const reader=new ConnectedShippingRead(liveService,root,(url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,before,readFetch,redact));
  const offer=liveExchange.offers.at(-1)!;
  assert.equal((await reader.preflight(liveExchange,offer)).amount,805);
  price='8.06';await assert.rejects(reader.preflight(liveExchange,offer),/rate changed/);price='8.05';
  account='OTHER';await assert.rejects(reader.preflight(liveExchange,offer),/Shipping evidence/);account='PRIVATE_ACCOUNT_CANARY';
  const beforeRace=readCalls;
  beforeRead=async()=>{await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);};
  await assert.rejects(reader.preflight(liveExchange,offer),/did not return verified/);assert.equal(readCalls,beforeRace);
  beforeRead=undefined;await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
  afterRead=async()=>{await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);};
  await assert.rejects(reader.preflight(liveExchange,offer),/account, item or private/);
  afterRead=undefined;await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
  await assert.rejects(reader.transaction(liveExchange,offer,labelOp,'transaction_fixture'),/has not been recorded/);
  await pool.query(`insert into pilot_operations(id,exchange_id,mode,kind,version,provider_id,state)
    values($1,$2,'live','label',$3,'transaction_fixture','succeeded')`,[labelOp,draft.id,offer.version]);
  assert.equal((await reader.transaction(liveExchange,offer,labelOp,'transaction_fixture')).state,'purchased');
  assert.equal((await reader.tracking(liveExchange,offer,labelOp,'transaction_fixture')).state,'in_transit');
  trackStatus='DELIVERED';assert.equal((await reader.tracking(liveExchange,offer,labelOp,'transaction_fixture')).state,'delivered');
  account='OTHER';await assert.rejects(reader.transaction(liveExchange,offer,labelOp,'transaction_fixture'),/Shipping evidence/);account='PRIVATE_ACCOUNT_CANARY';
  await assert.rejects(reader.refund(liveExchange,offer,'transaction_fixture','refund_fixture'),/has not been recorded/);
  await pool.query(`insert into pilot_operations(id,exchange_id,mode,kind,version,provider_id,state,result)
    values($1,$2,'live','label_refund',$3,'refund_fixture','succeeded',$4)`,[refundOp,draft.id,offer.version,{transactionId:'transaction_fixture'}]);
  assert.equal((await reader.refund(liveExchange,offer,'transaction_fixture','refund_fixture')).state,'pending');
  // A fresh connection generation permits reads only after fresh descriptions,
  // but never extends the original permission to spend.
  const nextGeneration=randomUUID();await pool.query('update pilot_connections set generation=$2 where id=$1',[connection,nextGeneration]);
  await assert.rejects(reader.transaction(liveExchange,offer,labelOp,'transaction_fixture'),/Describe GetTransaction/);
  await pool.query('update pilot_service_actions set generation=$2 where connection_id=$1',[connection,nextGeneration]);
  assert.equal((await reader.transaction(liveExchange,offer,labelOp,'transaction_fixture')).state,'purchased');
  await assert.rejects(reader.preflight(liveExchange,offer),/account, item or private/);
  await pool.query('update pilot_connections set generation=$2 where id=$1',[connection,generation]);
  await pool.query('update pilot_service_actions set generation=$2 where connection_id=$1',[connection,generation]);
  await checkConnectedWorker(repository,liveExchange,connection,root,[read,write],describe);
  await checkConnectedReturn(repository,liveExchange,connection,root,[read,write]);
  // Expire this synthetic offer and update its matching private digest: expiry
  // prohibits spend preflight while canonical known-transaction reads remain.
  offer.expiresAt='2026-01-01T00:00:00Z';
  const savedPrivate=await repository.privateInput(liveExchange,B);savedPrivate.connectedShipping![String(offer.version)]!.offerDigest=digest(offer);
  await repository.transaction(async sql=>{await repository.savePrivate(sql,liveExchange,B,savedPrivate);await sql.query('update pilot_exchanges set data=$2 where id=$1',[draft.id,liveExchange]);});
  assert.equal((await reader.transaction(liveExchange,offer,labelOp,'transaction_fixture')).state,'purchased');
  await assert.rejects(repository.transaction(sql=>requireConnectedOffer(liveService,sql,liveExchange,offer)),/expired/);
  for(const actor of [A,B]) {
    const projection=JSON.stringify(await liveService.get(actor,draft.id));
    for(const secret of ['TOKEN_CANARY','PRIVATE_ACCOUNT_CANARY','PRIVATE_ARTIFACT_CANARY']) assert(!projection.includes(secret));
  }
  process.stdout.write('PASS: approved private SDK rate creation/retrieval, two validated addresses, exact prices, active selected-carrier SDK verification, official public drop-off binding/expiry/area-change race and replay, expiry, live-mode evidence, private connected offer preparation, explicit seller sharing, separate exact approvals, live-postage/test-payment denial, privacy, duplicate/uncertain dispatch, consent withdrawal race, account binding, canonical SDK rate/transaction/tracking/refund reads, reauthorization and expiry separation, revocation races; no external calls or purchases.\n');
} finally {await pool.end();}
