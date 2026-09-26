/** Positive native-agent orchestration. Only OAuth/catalog, public source,
 * storage and commerce provider responses are synthetic. The caller supplies
 * actual Hermes owner turns and human commands; no tool result is fabricated. */
import {checkConnectedReturn} from './connected-return-check.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CommerceService } from '../src/commerce/service.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { ConnectionSecrets } from '../src/commerce/connection-secrets.js';
import { executeMcp, type ServiceInvocation } from '../src/commerce/mcp-execution.js';
import { ConnectedShipping } from '../src/commerce/connected-shipping.js';
import { connectedShippingContracts } from '../src/commerce/connected-shipping-read.js';
import { CommerceWorker } from '../src/commerce/worker.js';
import { EasyPostProvider, StripeProvider, providerConfig, type PaymentFact } from '../src/commerce/providers.js';
import { FedExLocations } from '../src/commerce/locations.js';
import { shippoAddressArguments, shippoOperationMetadata } from '../src/commerce/shippo-evidence.js';
import { verifyDropoff } from '../src/commerce/verified-dropoff.js';
import { verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { uspsLocationHtml, uspsLocationUrl } from '../test/fixtures/usps-dropoff.js';
import type { RunContext } from '../src/memory/domain.js';
import type { Operation } from '../src/commerce/domain.js';

export class PositiveFixtureCommerce extends CommerceService {
  observeTool?: (context:RunContext,input:unknown,result:unknown)=>void;
  providerFetch:FetchLike=async()=>{throw new Error('Synthetic shipping transport is not initialized');};
  override async invoke(context:RunContext,raw:unknown) {
    if((raw as {action?:string})?.action==='verify_dropoff') {
      const result=await verifyDropoff(this,context.userId,raw,request=>verifyPublicDropoff(request,url=>async()=>{
        assert.equal(url,uspsLocationUrl);return new Response(uspsLocationHtml());
      }));
      this.observeTool?.(context,raw,result);return result;
    }
    const result=await super.invoke(context,raw);this.observeTool?.(context,raw,result);return result;
  }
}
export type NativeAgentStep=(index:number,exchangeId:string,input:()=>Promise<unknown>,
  check:()=>Promise<boolean>,label:string)=>Promise<void>;
export async function checkHermesPositive(commerce:PositiveFixtureCommerce,root:string,agent:NativeAgentStep,
  human:(index:number,id:string,command:unknown)=>Promise<unknown>,
  eventually:(check:()=>Promise<boolean>,label:string,maxWaitMs?:number)=>Promise<void>,
  http:<T>(index:number,path:string,payload?:unknown,status?:number)=>Promise<T>) {
  const repository=commerce.repository,pool=repository.pool,[A,B]=commerce.founders as [string,string];
  assert.equal(commerce.mode,'live','Live tags bind synthetic provider evidence; no real spending is configured.');
  const requestInput={request:{item:'White Nike Air Force 1',style:'Low',size:'10',sizingSystem:'US men',condition:'Used good'},privateBudget:937123};
  const draft=await http<Awaited<ReturnType<CommerceService['get']>>>(0,'/v1/commerce/requests',{key:randomUUID(),input:requestInput});
  const id=draft.id;
  const view=(index=1)=>commerce.get(index===0?A:B,id);
  const revision=async()=>(await view()).revision;
  const command=(index:number,input:unknown)=>human(index,id,input);
  const prepare=async(index:number,input:unknown,label:string)=>{
    await agent(index,id,async()=>({action:'prepare_action',exchangeId:id,revision:await revision(),command:input,explanation:label}),
      async()=>!!(await view(index)).privateInput.agentAction,label);
    const action=(await view(index)).privateInput.agentAction!;
    await command(index,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest});
  };
  await command(0,{type:'share_request',requestDigest:draft.requestDigest});
  await eventually(async()=>!!(await pool.query("select id from pilot_messages where exchange_id=$1 and kind='request' and a2a_received_at is not null",[id])).rowCount,'Positive inquiry native A2A');
  const photo=randomUUID();
  await pool.query(`insert into pilot_assets(id,owner_id,exchange_id,kind,storage_path,mime,bytes,state)
    values($1,$2,$3,'photo',$4,'image/jpeg',100,'ready')`,[photo,B,id,`positive-fixture/${photo}`]);
  const item={itemId:randomUUID(),description:'White Nike Air Force 1',size:'10',sizingSystem:'US men',condition:'Used good',defects:'Light creasing',photoIds:[photo],sellerAmount:5000};
  await agent(1,id,async()=>({action:'draft_item',exchangeId:id,item}),async()=>!!(await repository.get(id,B)).itemDraft,'Seller native agent drafts item');
  assert.equal((await view(0)).item,null,'Agent draft shared without human approval');
  await command(1,{type:'share_item',item});
  const address={name:'Fixture',street1:'123 Test Street',street2:'',city:'New York',state:'NY',zip:'10001',country:'US' as const,phone:'+12125550100'};
  await command(0,{type:'address',address:{...address,street2:'BUYER_PRIVATE_ADDRESS_CANARY'}});
  await command(1,{type:'address',address:{...address,street2:'SELLER_PRIVATE_ADDRESS_CANARY'}});
  await command(1,{type:'packing',packing:{weightOz:32,lengthIn:12,widthIn:8,heightIn:6,packed:true,canPrint:false}});
  await command(1,{type:'research_area',postcode:'10001'});
  // Synthetic boundary: an owner-authorized connection and observed catalog.
  // Dedicated OAuth/inspection suites cover the real authorization machinery.
  const research=randomUUID(),connection=randomUUID(),generation=randomUUID(),endpoint='https://mcp.shippo.com/';
  const read:ServiceInvocation['tool']={name:'shippo_read_execute_tool',description:'Read',inputSchema:{type:'object',properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments']}};
  const write={...read,name:'shippo_write_execute_tool',description:'Write'},tools=[read,write];
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,approved_at,result)
    values($1,$2,$3,'live','inspect_mcp',$4,$5,'ready',now(),$6)`,[research,id,B,{url:endpoint,addressVersion:1},randomUUID(),{sources:[],mcp:{status:'authorization_required'}}]);
  const sealed=new ConnectionSecrets(root).seal(JSON.stringify([connection,B,id,'live',endpoint]),{tokens:{access_token:'TOKEN_CANARY',token_type:'Bearer'}});
  await pool.query(`insert into pilot_connections(id,exchange_id,owner_id,research_id,mode,endpoint,state,generation,credentials,inspection,access_expires_at)
    values($1,$2,$3,$4,'live',$5,'connected',$6,$7,$8,now()+interval '2 hours')`,
    [connection,id,B,research,endpoint,generation,sealed,{status:'inspected',transport:'streamable_http',tools,authority:'untrusted_capabilities_only'}]);
  const describe=async(name:string,kind:string,fields:Record<string,string>)=>{
    const action=randomUUID();
    await pool.query(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,endpoint,
      invocation,explanation,digest,call_digest,state,result,expires_at)
      values($1,$2,$3,$4,'live',$5,1,$6,$7,$8,'positive fixture description',$9,$10,'returned',$11,now()+interval '1 hour')`,
      [action,id,B,connection,randomUUID(),generation,endpoint,{tool:{name:'shippo_describe_tool',description:'Describe',inputSchema:{type:'object'}},arguments:{name}},
        'd'.repeat(64),'e'.repeat(64),{text:[],omittedContentTypes:[],structuredContent:{name,kind,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,{type}])),required:Object.keys(fields)}}}]);
    return action;
  };
  const validationDescription=await describe('ValidateAddress','read',Object.fromEntries(Object.keys(shippoAddressArguments(address)).map(key=>[key,'string'])));
  const creationDescription=await describe('CreateShipment','write',{address_from:'object',address_to:'object',parcels:'array',metadata:'string',async:'boolean',extra:'object'});
  let carrierDescription='';
  for(const [name,fields] of Object.entries(connectedShippingContracts)) {
    const action=await describe(name,name.startsWith('Create')?'write':'read',fields);
    if(name==='GetCarrierAccount') carrierDescription=action;
  }
  let purchases=0,shipments=0,checkouts=0,tracking='PRE_TRANSIT',labelId='';
  let status:PaymentFact['status']='open';
  const rate=()=>({object_id:'positive_rate',object_owner:'PRIVATE_ACCOUNT_CANARY',object_created:new Date().toISOString(),test:false,
    shipment:'positive_shipment',carrier_account:'positive_carrier',provider:'USPS',servicelevel:{token:'usps_ground_advantage',name:'Ground Advantage'},amount:'8.05',currency:'USD',estimated_days:3});
  const fixtureFetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'positive-fixture',version:'1'}};
    else if(message.method==='tools/list') result={tools};
    else {
      const {name,arguments:args}=message.params.arguments;
      let payload:unknown;
      if(name==='ValidateAddress') payload={original_address:args,analysis:{validation_result:{value:'valid'}}};
      else if(name==='CreateShipment') {
        shipments++;assert.equal(args.address_from.street2,'SELLER_PRIVATE_ADDRESS_CANARY');assert.equal(args.address_to.street2,'BUYER_PRIVATE_ADDRESS_CANARY');
        assert.equal(args.extra.qr_code_requested,true);
        payload={...args,object_id:'positive_shipment',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,status:'SUCCESS',
          parcels:[{...args.parcels[0],object_id:'positive_parcel'}],rates:[rate()]};
      } else if(name==='GetCarrierAccount') payload={object_id:'positive_carrier',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,active:true,carrier:'usps'};
      else if(name==='GetRate') payload=rate();
      else if(name==='CreateTransaction' || name==='GetTransaction') {
        if(name==='CreateTransaction') {purchases++;assert.equal(status,'paid');assert.equal(args.metadata,shippoOperationMetadata(labelId));}
        else assert.equal(args.TransactionId,'positive_transaction');
        payload={object_id:'positive_transaction',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,metadata:shippoOperationMetadata(labelId),rate:'positive_rate',parcel:'positive_parcel',status:'SUCCESS',
          tracking_number:'POSITIVE_TRACKING',label_file_type:'PDF',label_url:'https://deliver.goshippo.com/positive-label.pdf',qr_code_url:'https://deliver.goshippo.com/positive-code.pdf?PRIVATE_ARTIFACT_CANARY'};
      } else {assert.equal(name,'GetTrack');payload={carrier:'usps',tracking_number:'POSITIVE_TRACKING',transaction:'positive_transaction',
        tracking_status:{object_id:`positive_${tracking}`,object_updated:new Date().toISOString(),status_date:new Date().toISOString(),status:tracking}};}
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const execute=(url:string,invocation:ServiceInvocation,before:()=>Promise<void>,_fetch:unknown,redact?:((s:string)=>string))=>executeMcp(url,invocation,before,fixtureFetch,redact);
  commerce.providerFetch=fixtureFetch;
  await prepare(1,{type:'propose_shipping_data',connectionId:connection},'Seller agent prepares free data consent');
  const consent=(await view()).shippingData!;assert.equal(consent.approvalCount,0);
  for(const index of [0,1]) await command(index,{type:'decide_shipping_data',consentId:consent.id,consentDigest:consent.digest,approve:true,acknowledgeServiceAccountAccess:true});
  const serviceStep=async(input:()=>Promise<unknown>,purpose:'free_address_validation'|'free_shipping_rates'|'free_shipping_option',label:string)=>{
    const before=new Set((await pool.query('select id from pilot_service_actions where exchange_id=$1',[id])).rows.map(r=>r.id));
    await agent(1,id,input,async()=>!!(await pool.query("select id from pilot_service_actions where exchange_id=$1 and state='review'",[id])).rowCount,label);
    const action=(await view()).serviceActions.find(a=>!before.has(a.id) && a.state==='review');assert(action,label);
    assert.equal(purchases,0,'Model preparation bought postage');
    const flag={free_address_validation:'approveFreeAddressValidation',free_shipping_rates:'approveFreeShippingRates',free_shipping_option:'approveFreeShippingOption'}[purpose];
    const payload={digest:action.digest,approve:true,[flag]:true},path=`/v1/commerce/service-actions/${action.id}/decision`;
    await http(0,path,payload,404);await http(-1,path,payload,401);
    await http(1,path,{...payload,digest:'f'.repeat(64)},409);
    return http<Awaited<ReturnType<CommerceConnections['decideAction']>>>(1,path,payload);

  };
  const base=async()=>({exchangeId:id,revision:await revision(),connectionId:connection,consentId:consent.id});
  for(const addressRole of ['buyer','seller']) await serviceStep(async()=>({...await base(),action:'prepare_shipping_validation',descriptionActionId:validationDescription,addressRole}),
    'free_address_validation',`Seller agent prepares ${addressRole} private validation`);
  const rates=await serviceStep(async()=>({...await base(),action:'prepare_shipping_rates',descriptionActionId:creationDescription}),'free_shipping_rates','Seller agent prepares private rates');
  assert.equal(shipments,1);
  const carrier=await serviceStep(async()=>({action:'prepare_shipping_option',exchangeId:id,revision:await revision(),rateActionId:rates.id,rateId:'positive_rate',descriptionActionId:carrierDescription}),
    'free_shipping_option','Seller agent verifies selected carrier');
  const nearby=randomUUID(),source=randomUUID();
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,result)
    values($1,$2,$3,'live','nearby',$4,$5,'ready',$6)`,[nearby,id,B,{query:'fixture location search',addressVersion:(await view()).privateInput.discoveryVersion},randomUUID(),
    {sources:[{id:source,url:uspsLocationUrl,title:'Fixture official USPS source',description:'Synthetic public result'}],checkedAt:new Date().toISOString(),verifiedForFulfillment:false}]);
  await agent(1,id,async()=>({action:'verify_dropoff',exchangeId:id,revision:await revision(),carrierActionId:carrier.id,researchId:nearby,sourceId:source}),
    async()=>!!(await view()).verifiedDropoff,'Seller agent verifies retail no-printer drop-off');
  const dropoff=(await view()).verifiedDropoff!;
  await agent(1,id,async()=>({action:'prepare_connected_offer',exchangeId:id,revision:await revision(),dropoffId:dropoff.id}),
    async()=>!!(await view()).connectedOfferDraft,'Seller agent prepares exact paid terms');
  const prepared=(await view()).connectedOfferDraft!;
  assert.equal((await view(0)).offer,null);assert.equal(checkouts,0);assert.equal(purchases,0);
  await command(1,{type:'share_connected_offer',draftId:prepared.id,draftDigest:prepared.digest});
  const offer=(await view()).offer!;assert.equal(offer.buyerTotal,5805);assert.equal(offer.quote.artifact,'label_qr');
  for(const index of [0,1]) await command(index,{type:'approve',binding:(await view(index)).approval,acknowledgeSellerPostageReimbursement:true,acknowledgeConnectedShipping:true});
  await prepare(0,{type:'checkout'},'Buyer agent prepares hosted payment');
  const config=providerConfig({},'live');
  const fact=():PaymentFact=>({sessionId:'cs_positive_fixture',status,amount:5805,currency:'usd',paymentIntentId:'pi_positive',chargeId:'ch_positive',
    transferId:status==='paid'?'tr_positive':null,transferred:status==='paid',transferReversed:false,transferReversedAmount:0,refunded:false,refundedAmount:0,destinationPaymentId:'py_positive',checkoutUrl:status==='open'?'https://checkout.stripe.com/c/pay/fixture':null});
  class StripeFixture extends StripeProvider {
    override async checkout(){checkouts++;return fact();}
    override async retrieve(){return fact();}
    override async payout(){return {id:'po_positive',status:'paid' as const,amount:5805};}
  }
  const connected=new ConnectedShipping(commerce,root,execute);
  const worker=()=>new CommerceWorker(repository,commerce,{stripe:new StripeFixture(config),connectedShipping:connected,
    shipping:new EasyPostProvider(config,async()=>{assert.fail('Positive flow reached platform postage');}),locations:new FedExLocations(config)});
  const operation=async(kind:string):Promise<Operation>=>{
    const r=(await pool.query('select * from pilot_operations where exchange_id=$1 and kind=$2',[id,kind])).rows[0];assert(r,kind);
    return {id:r.id,exchangeId:r.exchange_id,kind:r.kind,version:r.version,mode:r.mode,state:r.state,providerId:r.provider_id,result:r.result,attempts:r.attempts,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()};
  };
  await worker().process(await operation('checkout'));assert.equal(checkouts,1);assert.equal(purchases,0);assert.equal((await view()).payment,'pending');
  status='paid';await worker().process(await operation('checkout'));
  await http(1,`/v1/commerce/exchanges/${id}/label`,undefined,409);
  labelId=(await operation('label')).id;
  await Promise.all([worker().process(await operation('label')),worker().process(await operation('label'))]);
  assert.equal(purchases,1);assert.equal((await view()).shipping,'label_ready');
  const current=await repository.get(id,B),artifact=await connected.transaction(current,offer,labelId,'positive_transaction');
  assert.equal(artifact.state,'purchased');if(artifact.state==='purchased') {assert.equal(artifact.artifact,'label_qr');assert(artifact.privateArtifactUrl.includes('positive-code.pdf'));}
  const labelPath=`/v1/commerce/exchanges/${id}/label`;
  await http(0,labelPath,undefined,403);await http(-1,labelPath,undefined,401);
  const downloaded=await http<{artifact:string;mime:string;base64:string}>(1,labelPath);
  assert.equal(downloaded.artifact,'label_qr');assert.equal(downloaded.mime,'application/pdf');
  assert(Buffer.from(downloaded.base64,'base64').toString().startsWith('%PDF-1.7'));
  assert(!JSON.stringify(downloaded).includes('PRIVATE_ARTIFACT_CANARY'));
  await command(1,{type:'dropped_off'});assert.equal((await view()).carrierAcceptedAt,null,'Human handoff invented carrier evidence');
  tracking='TRANSIT';await worker().process(await operation('label'));assert.equal((await view()).shipping,'in_transit');
  tracking='DELIVERED';await worker().process(await operation('label'));assert.equal((await view()).shipping,'delivered');
  assert.notEqual((await view()).stage,'completed','Carrier delivery invented human receipt');
  await command(0,{type:'received'});await worker().process(await operation('payout'));
  assert.equal((await view()).stage,'completed');assert.equal((await view()).payout,'paid');assert.equal(purchases,1);assert.equal(checkouts,1);
  await eventually(async()=>!(await pool.query(`select id from pilot_messages where exchange_id=$1 and sender_id<>recipient_id and a2a_received_at is null`,[id])).rowCount,'Positive full-flow native A2A receipts');
  for(const actor of [A,B]) {
    const state=JSON.stringify(await commerce.invoke({userId:actor,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:id}));
    for(const secret of ['PRIVATE_ADDRESS_CANARY','PRIVATE_ACCOUNT_CANARY','TOKEN_CANARY','PRIVATE_ARTIFACT_CANARY']) assert(!state.includes(secret));
  }
  let returnPreparations=0;
  const prepareReturn=async(actor:string,input:()=>Promise<unknown>)=>{
    const index=actor===A?0:1,expected=await input() as {action:string};let observed:unknown;
    commerce.observeTool=(context,raw,result)=>{
      const call=raw as {action?:string;exchangeId?:string};
      if(context.userId===actor && call.action===expected.action && call.exchangeId===id) observed=result;
    };
    try {
      await agent(index,id,input,async()=>observed!==undefined,`Native return ${expected.action}`);
      returnPreparations++;return observed;
    } finally {delete commerce.observeTool;}
  };
  await checkConnectedReturn(repository,await repository.get(id,A),connection,root,tools,true,{prepare:prepareReturn,
    human:async(actor,input)=>human(actor===A?0:1,id,input)});
  assert.equal(returnPreparations,6);
  // The negative branches deliberately create a burst of owner decisions.
  // Native delivery leases one message per sender every five seconds. Allow
  // that bounded queue to drain; retain the shorter deadline for single steps.
  const queued=(await pool.query<{pending:number}>(`select count(*)::int pending from pilot_messages
    where exchange_id=$1 and sender_id<>recipient_id and a2a_received_at is null group by sender_id`,[id])).rows;
  const pending=Math.max(0,...queued.map(row=>row.pending));
  assert(pending<=40,'Unexpected return message burst');
  await eventually(async()=>!(await pool.query(`select id from pilot_messages where exchange_id=$1 and sender_id<>recipient_id and a2a_received_at is null`,[id])).rowCount,
    'Return native A2A receipts',Math.min(280_000,40_000+pending*6000));
  return {exchangeId:id,agentPreparations:9+returnPreparations,returnPreparations,
    returnFlow:'native seller validation/rates/carrier and buyer drop-off/quote preparation; authenticated human decisions; SDK fixture purchase/tracking/refund and recovery',postagePurchases:purchases,checkouts,carrier:'USPS Ground Advantage',artifact:'provider QR PDF through authenticated sender-only HTTP',
    serviceApprovalBoundary:'authenticated HTTP, wrong-owner/anonymous/tampered-digest denial',
    result:'completed with human receipt and exact seller reimbursement/payout',
    syntheticBoundaries:'model choices, authorized OAuth/catalog, photo storage, public location HTTP, Stripe, shipping and artifact download bytes; no real payment/postage/delivery'};
}
