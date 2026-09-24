/** Real disposable Postgres; no model, third-party disclosure or purchase. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { requireShippingDataConsent } from '../src/commerce/shipping-consent.js';

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
  const research = randomUUID(), connection = randomUUID(), generation = randomUUID(), endpoint = 'https://mcp.vendor.com/';
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
  process.stdout.write('PASS: two-owner private data consent, exact form/connection/expiry binding, owner-model isolation, withdrawal, restart and zero provider dispatch.\n');
} finally { await pool.end(); }
