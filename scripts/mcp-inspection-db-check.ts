/** Disposable database acceptance for owner-approved service inspection. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import type { McpInspection } from '../src/commerce/mcp-inspection.js';
const url=process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const pool=new pg.Pool({connectionString:url});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const PA='apt-aaaaaaaaaaaaaaaaaaaa';
const repo=new CommerceRepository(pool);
const service=()=>new CommerceService(repo,[A,B],'test');
const command=async(actor:string,id:string,input:unknown)=>{
  const e=await service().get(actor,id);
  return service().command(actor,id,randomUUID(),e.revision,input);
};
let requests=0;
const inspector=async(endpoint:string):Promise<McpInspection>=>{
  requests++;assert.equal(endpoint,'https://mcp.vendor.com/mcp');
  return {status:'inspected',transport:'streamable_http',tools:[{name:'track_package',description:'Fixture only',inputSchema:{type:'object'}}],authority:'untrusted_capabilities_only'};
};
try {
  const e=await service().create(A,randomUUID(),{request:{item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Used good'},privateBudget:937123});
  await command(A,e.id,{type:'research_area',postcode:'10001'});
  const parent=await service().research.request(A,e.id,{kind:'nearby'});
  const lease=(await service().research.outbox(PA)).jobs.find(j=>j.id===parent.id)!;assert(lease);
  await service().research.complete(PA,{id:parent.id,leaseId:lease.leaseId,result:{success:true,sources:[
    {url:'https://mcp.vendor.com/mcp',title:'Synthetic remote service',description:'Fixture only'},
    {url:'https://mcp.other-vendor.com/mcp',title:'Other service',description:'Fixture only'},
    {url:'https://mcp.old-area.com/mcp',title:'Prior area service',description:'Fixture only'},
    {url:'https://mcp.stale-service.com/mcp',title:'Stale service',description:'Fixture only'},
  ]}});
  const parentResult=(await service().research.list(A,e.id)).find(j=>j.id===parent.id)!;
  const propose=(index=0)=>service().research.request(A,e.id,{kind:'inspect_mcp',researchId:parent.id,sourceId:parentResult.result!.sources[index]!.id});
  const [proposal,replay]=await Promise.all([propose(),propose()]);
  assert.equal(proposal.id,replay.id);assert.equal(proposal.state,'awaiting_approval');
  await service().research.inspectPending(inspector);assert.equal(requests,0,'Unapproved endpoint contacted');
  assert.equal((await service().research.outbox(PA)).jobs.length,0,'Unapproved inspection leaked to research bridge');
  const approval={type:'decide_mcp_inspection',researchId:proposal.id,inspectionDigest:proposal.inspectionDigest,approve:true};
  await assert.rejects(command(A,e.id,{...approval,inspectionDigest:'f'.repeat(64)}),/changed/);
  await assert.rejects(service().invoke({userId:A,runId:randomUUID(),requestMessageId:randomUUID()},
    {action:'prepare_action',exchangeId:e.id,revision:(await service().get(A,e.id)).revision,command:approval,explanation:'Try to approve a service myself'}));
  await command(A,e.id,{type:'share_request',requestDigest:e.requestDigest});
  await assert.rejects(command(B,e.id,approval),/changed/);
  assert.deepEqual(await service().research.list(B,e.id),[]);
  await command(A,e.id,approval);
  await assert.rejects(command(A,e.id,approval),/changed/);
  assert.equal((await service().research.outbox(PA)).jobs.length,0,'Approved inspection delegated to model bridge');
  // Simulated server crash after claim. A fresh service instance resumes the
  // durable approval with a different lease; no private data enters the call.
  const oldLease=randomUUID();
  await pool.query("update pilot_research set state='running',attempts=1,lease_id=$2,updated_at=now()-interval '2 minutes' where id=$1",[proposal.id,oldLease]);
  await assert.rejects(service().research.complete(PA,{id:proposal.id,leaseId:oldLease,result:{success:true,sources:[]}}),/not found/);
  await Promise.all([service().research.inspectPending(inspector),service().research.inspectPending(inspector)]);
  assert.equal(requests,1,'Duplicate concurrent inspection');
  const done=(await service().research.list(A,e.id)).find(j=>j.id===proposal.id)!;
  assert.equal(done.state,'ready');assert.equal(done.result?.mcp?.status,'inspected');
  assert.equal(done.result?.verifiedForFulfillment,false);
  assert(!JSON.stringify(done.result).includes('937123'));
  assert.equal((await service().get(A,e.id)).shipping,'none');
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[e.id])).rows[0].n,0);
  assert((await service().inbox(A)).some(m=>m.payload.action==='research_update'));
  await service().research.inspectPending(inspector);assert.equal(requests,1);
  const declined=await propose(1);
  await command(A,e.id,{type:'decide_mcp_inspection',researchId:declined.id,inspectionDigest:declined.inspectionDigest,approve:false});
  await service().research.inspectPending(inspector);assert.equal(requests,1);
  await assert.rejects(command(A,e.id,{type:'retry_research',researchId:declined.id}),/Only your/);
  const oldArea=await propose(2);
  const stale=await propose(3);
  await command(A,e.id,{type:'decide_mcp_inspection',researchId:oldArea.id,inspectionDigest:oldArea.inspectionDigest,approve:true});
  await command(A,e.id,{type:'research_area',postcode:'10002'});
  await assert.rejects(command(A,e.id,{type:'decide_mcp_inspection',researchId:stale.id,inspectionDigest:stale.inspectionDigest,approve:true}),/changed/);
  await service().research.inspectPending(inspector);assert.equal(requests,1,'Prior-area inspection contacted a service');
  await assert.rejects(command(A,e.id,{type:'retry_research',researchId:oldArea.id}),/Only your/);
  const live=new CommerceService(repo,[A,B],'live');
  await live.research.inspectPending(inspector);assert.equal(requests,1);
  await assert.rejects(live.research.list(A,e.id),/not found/);
  // Research still has forced RLS and no direct client privileges after migration.
  const protection=await pool.query("select relrowsecurity,relforcerowsecurity,has_table_privilege('authenticated','public.pilot_research','select') as client from pg_class where oid='public.pilot_research'::regclass");
  assert.deepEqual(protection.rows[0],{relrowsecurity:true,relforcerowsecurity:true,client:false});
  process.stdout.write('PASS: observed-endpoint proposals, exact owner approval/denial, private/mode isolation, no model forgery, crash recovery, concurrent claims, no fulfillment side effects and retained RLS.\n');
} finally {await pool.end();}
