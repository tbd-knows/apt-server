/** Real disposable Postgres; no model, third-party disclosure or purchase. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../src/commerce/domain.js';
import pg from 'pg';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { requireShippingDataConsent } from '../src/commerce/shipping-consent.js';
import { prepareShippingValidation } from '../src/commerce/shipping-validation.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { ConnectionSecrets } from '../src/commerce/connection-secrets.js';
import { executeMcp } from '../src/commerce/mcp-execution.js';
import { shippoAddressArguments } from '../src/commerce/shippo-evidence.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const url = process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const pool = new pg.Pool({ connectionString: url });
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const repository = new CommerceRepository(pool);
let now = new Date();
const service = () => new CommerceService(repository,[A,B],'test',()=>now);
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
  const prepared = view.privateInput.agentAction!;
  await command(B,draft.id,{type:'approve_agent_action',actionId:prepared.id,actionDigest:prepared.digest});
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
  const messages = (await pool.query('select payload from pilot_messages where exchange_id=$1',[draft.id])).rows;
  assert(!JSON.stringify(messages).includes('PRIVATE_ADDRESS_CANARY'));
  assert(!JSON.stringify(messages).includes('937123'));
  // Approved private inputs now drive an actual SDK tools/call against a fixture.
  // Tool names, wrapper schema and nested operation description are all observed
  // discovery fixtures, not a claim of authenticated production compatibility.
  const wrapper={name:'shippo_read_execute_tool',description:'Read operation',inputSchema:{type:'object',
    properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments']}};
  const descriptionActionId=randomUUID(),root='r'.repeat(32);
  const description={name:'ValidateAddress',kind:'read',inputSchema:{type:'object',
    properties:Object.fromEntries(Object.keys(shippoAddressArguments(privateInputs.destination)).map(key=>[key,{type:'string'}])),
    required:['address_line_1','country_code']}};
  await pool.query(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,endpoint,
    invocation,explanation,digest,call_digest,state,result,approved_at,expires_at)
    values($1,$2,$3,$4,'test',$5,1,$6,$7,$8,'fixture discovery',$9,$10,'returned',$11,now(),now()+interval '1 hour')`,
    [descriptionActionId,draft.id,B,connection,randomUUID(),generation,endpoint,
      {tool:{name:'shippo_describe_tool',description:'Describe',inputSchema:{type:'object'}},arguments:{name:'ValidateAddress'}},
      'd'.repeat(64),'e'.repeat(64),{text:[],structuredContent:description,omittedContentTypes:[]}]);
  const sealed=new ConnectionSecrets(root).seal(JSON.stringify([connection,B,draft.id,'test',endpoint]),{tokens:{access_token:'TOKEN_CANARY',token_type:'Bearer'}});
  await pool.query("update pilot_connections set credentials=$2,inspection=$3,access_expires_at=now()+interval '1 hour' where id=$1",
    [connection,sealed,{status:'inspected',transport:'streamable_http',tools:[wrapper],authority:'untrusted_capabilities_only'}]);
  let validationCalls=0,expectedAction='',failAfterSend=false;
  let onList:(()=>Promise<void>)|undefined;
  const fetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
    else if(message.method==='tools/list') {await onList?.();result={tools:[wrapper]};}
    else {
      validationCalls++;
      assert.equal((await pool.query('select state from pilot_service_actions where id=$1',[expectedAction])).rows[0].state,'running');
      assert.equal(message.params.name,wrapper.name);assert.equal(message.params.arguments.name,'ValidateAddress');
      assert.equal(message.params.arguments.arguments.address_line_2,'BUYER_PRIVATE_ADDRESS_CANARY');
      if(failAfterSend) throw new Error('PRIVATE_REMOTE_FAILURE');
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{secret:'TOKEN_CANARY'},
        AddressValidationResultV2:{original_address:message.params.arguments.arguments,
          recommended_address:{...message.params.arguments.arguments,postal_code:'10001-1234'},
          analysis:{validation_result:{value:'partially_valid'},changed_attributes:['postal_code']}}})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const connections=new CommerceConnections(service(),root,'https://app.tbd.com',undefined,undefined,
    (url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,before,fetch,redact));
  const validationInput=async()=>({action:'prepare_shipping_validation' as const,exchangeId:draft.id,revision:(await service().get(B,draft.id)).revision,
    connectionId:connection,consentId:initial.id,descriptionActionId,addressRole:'buyer' as const});
  const input=await validationInput();
  await assert.rejects(prepareShippingValidation(service(),A,randomUUID(),input),/other participant/);
  await assert.rejects(prepareShippingValidation(service(),B,randomUUID(),{...input,arguments:{arbitrary:'private'}}));
  const preparedLookup=await prepareShippingValidation(service(),B,randomUUID(),input);
  assert.equal(preparedLookup.purpose,'free_address_validation');assert(!JSON.stringify(preparedLookup).includes('PRIVATE_ADDRESS_CANARY'));
  await assert.rejects(connections.decideAction(B,preparedLookup.id,preparedLookup.digest,true),/correct service action purpose/);
  await assert.rejects(connections.decideAction(A,preparedLookup.id,preparedLookup.digest,true,'free_address_validation'),/not found/);
  expectedAction=preparedLookup.id;
  const validated=await connections.decideAction(B,preparedLookup.id,preparedLookup.digest,true,'free_address_validation');
  assert.equal(validationCalls,1);assert.equal(validated.result?.structuredContent?.addressValidation,'correction_required');
  assert(!JSON.stringify(validated).includes('CANARY'));
  assert.equal((await service().get(A,draft.id)).privateInput.suggestedAddress?.zip,'10001-1234');
  assert.equal((await service().get(B,draft.id)).privateInput.suggestedAddress,undefined);
  const sellerModel=await service().invoke(context,{action:'state',exchangeId:draft.id});
  assert(!JSON.stringify(sellerModel).includes('PRIVATE_ADDRESS_CANARY'));
  assert(!JSON.stringify(sellerModel).includes('10001-1234'));
  const persisted=(await pool.query('select result from pilot_service_actions where id=$1',[preparedLookup.id])).rows[0].result;
  assert(!JSON.stringify(persisted).includes('CANARY'));
  await connections.decideAction(B,preparedLookup.id,preparedLookup.digest,true,'free_address_validation');assert.equal(validationCalls,1);
  assert.equal((await prepareShippingValidation(service(),B,randomUUID(),await validationInput())).id,preparedLookup.id);
  // A new consent changes the dispatch identity; cancellation before dispatch
  // invalidates it even though both people approved the former proposal.
  const newPlan=(await propose()).shippingData!;await decide(A);await decide(B);
  const pendingLookup=await prepareShippingValidation(service(),B,randomUUID(),{...await validationInput(),consentId:newPlan.id});
  await decide(A,false);
  await assert.rejects(connections.decideAction(B,pendingLookup.id,pendingLookup.digest,true,'free_address_validation'),/Both owners/);
  assert.equal(validationCalls,1);
  const uncertainPlan=(await propose()).shippingData!;await decide(A);await decide(B);
  const ambiguous=await prepareShippingValidation(service(),B,randomUUID(),{...await validationInput(),consentId:uncertainPlan.id});
  expectedAction=ambiguous.id;failAfterSend=true;
  assert.equal((await connections.decideAction(B,ambiguous.id,ambiguous.digest,true,'free_address_validation')).state,'uncertain');
  assert.equal(validationCalls,2);
  assert.equal((await prepareShippingValidation(service(),B,randomUUID(),{...await validationInput(),consentId:uncertainPlan.id})).id,ambiguous.id);
  failAfterSend=false;
  const racingPlan=(await propose()).shippingData!;await decide(A);await decide(B);
  const racing=await prepareShippingValidation(service(),B,randomUUID(),{...await validationInput(),consentId:racingPlan.id});
  onList=async()=>{await decide(A,false);};expectedAction=racing.id;
  assert.equal((await connections.decideAction(B,racing.id,racing.digest,true,'free_address_validation')).state,'failed');
  assert.equal(validationCalls,2,'Consent withdrawn during schema preflight prevents private address dispatch');onList=undefined;
  await assert.rejects(new CommerceService(repository,[A,B],'live').get(A,draft.id),/not found/);
  await assert.rejects(service().get('33333333-3333-4333-8333-333333333333',draft.id),/two configured/);
  await decide(A,false);
  assert.equal((await service().get(B,draft.id)).shippingData?.state,'declined');
  await assert.rejects(resolve(initial.id),/Both owners/);
  await assert.rejects(decide(B),/expired or its inputs/);
  let replacement = (await propose()).shippingData!;
  await decide(A); await decide(B);
  await assert.rejects(resolve(initial.id),/Both owners/);
  await command(A,draft.id,{type:'address',address:{...address,street2:'Changed private address'}});
  assert.equal((await service().get(B,draft.id)).shippingData?.state,'expired');
  await assert.rejects(resolve(replacement.id),/inputs or connection changed/);
  replacement = (await propose()).shippingData!; await decide(A); await decide(B);
  await command(B,draft.id,{type:'packing',packing:{weightOz:33,lengthIn:12,widthIn:8,heightIn:6,packed:true,canPrint:true}});
  await assert.rejects(resolve(replacement.id),/inputs or connection changed/);
  replacement = (await propose()).shippingData!; await decide(A); await decide(B);
  await pool.query('update pilot_connections set generation=$2 where id=$1',[connection,randomUUID()]);
  await assert.rejects(resolve(replacement.id),/inputs or connection changed/);
  replacement = (await propose()).shippingData!; await decide(A); await decide(B);
  now = new Date(now.getTime()+31*60_000);
  assert.equal((await service().get(B,draft.id)).shippingData?.state,'expired');
  await assert.rejects(resolve(replacement.id),/expired/); now = new Date();
  replacement = (await propose()).shippingData!; await decide(A); await decide(B);
  await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);
  await assert.rejects(resolve(replacement.id),/connection changed/);
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[draft.id])).rows[0].n,0,'Disclosure permission must not queue purchases or claims');
  assert.equal((await service().get(B,draft.id)).payment,'unpaid');
  assert.equal((await service().get(B,draft.id)).shipping,'none');
  // A return has its own two-owner consent, sender and packing. The original
  // sale's expired disclosure cannot authorize reverse address disclosure.
  await pool.query("update pilot_connections set state='connected',generation=$2 where id=$1",[connection,generation]);
  const resolutionId=randomUUID(),authorizationId=randomUUID();
  await pool.query(`update pilot_exchanges set data=data||$2::jsonb where id=$1`,[draft.id,{
    payment:'paid',stage:'needs_attention',shipping:'delivered',cancellationRequested:true,problem:'Return agreed',expiresAt:'2020-01-01T00:00:00Z',
    offers:[{version:1,item:{sellerAmount:5000},quote:{shippingAmount:500},taxAmount:0,feeAmount:0,buyerTotal:5500,currency:'USD',
      postageFunding:'seller_reimbursed',connectedShipping:{authorizationId}}],
    resolution:{id:resolutionId,remedy:'return',reason:'Fixture return',offerDigest:'fixture',amount:5500,currency:'USD',expiresAt:new Date(Date.now()+86400000).toISOString(),approvedBy:[A,B]},
    returnPlan:{resolutionId,version:0,quote:null,subsidy:'',approvals:[],shipping:'none',droppedAt:null,carrierAcceptedAt:null,trackingUpdatedAt:null,receivedAt:null}}]);
  await repository.transaction(async sql=>{
    const e=await repository.get(draft.id,B,sql);
    e.resolution!.offerDigest=digest(e.offers.at(-1));
    await repository.save(sql,e,new Date());
    const seller=await repository.privateInput(e,B,sql);
    await sql.query('update pilot_private_inputs set data=$3 where exchange_id=$1 and owner_id=$2',[e.id,B,
      {...seller,connectedShipping:{'1':{connectionId:connection,authorizationId}}}]);
  });
  await assert.rejects(resolve(replacement.id),/expired/);
  await assert.rejects(propose(),/packed dimensions/);
  await command(A,draft.id,{type:'return_packing',packing:{weightOz:41,lengthIn:14,widthIn:9,heightIn:7,packed:true,canPrint:true}});
  const returnPermission=(await propose()).shippingData!;
  assert.equal(returnPermission.purpose,'free_return_shipping_rates_only');
  await decide(A);await assert.rejects(resolve(returnPermission.id),/Both owners/);await decide(B);
  const reverse=await resolve(returnPermission.id);
  assert.equal(reverse.origin.street2,'Changed private address');assert.equal(reverse.destination.street2,'SELLER_PRIVATE_ADDRESS_CANARY');
  assert.equal(reverse.packing.weightOz,41,'Return uses buyer packing rather than outbound seller packing');
  const reverseLookup=await prepareShippingValidation(service(),B,randomUUID(),{...await validationInput(),consentId:returnPermission.id});
  const reverseInvocation=(await pool.query('select invocation from pilot_service_actions where id=$1',[reverseLookup.id])).rows[0].invocation;
  assert.equal(reverseInvocation.arguments.arguments.address_line_2,'Changed private address');
  assert.equal(reverseInvocation.shippingValidation.addressVersion,(await service().get(A,draft.id)).privateInput.addressVersion);
  assert(!JSON.stringify(reverseLookup).includes('Changed private address'));
  await command(A,draft.id,{type:'return_packing',packing:{weightOz:42,lengthIn:14,widthIn:9,heightIn:7,packed:true,canPrint:true}});
  await assert.rejects(resolve(returnPermission.id),/inputs or connection changed/);
  await assert.rejects(connections.decideAction(B,reverseLookup.id,reverseLookup.digest,true,'free_address_validation'),/inputs or connection changed/);
  const refreshedReturn=(await propose()).shippingData!;await decide(A);await decide(B);
  await pool.query(`update pilot_exchanges set data=jsonb_set(data,'{resolution,approvedBy}',$2::jsonb) where id=$1`,[draft.id,JSON.stringify([B])]);
  await assert.rejects(resolve(refreshedReturn.id),/inputs or connection changed/);
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[draft.id])).rows[0].n,0);
  process.stdout.write('PASS: two-owner private data consent, exact form/connection/expiry binding, owner-model isolation, withdrawal, restart, actual SDK free-validation fixture, private correction routing, replay/uncertainty; no external provider calls or purchases.\n');
} finally { await pool.end(); }
