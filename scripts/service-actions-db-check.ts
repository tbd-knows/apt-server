/** Real disposable Postgres and MCP SDK, deterministic remote service only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { ConnectionSecrets } from '../src/commerce/connection-secrets.js';
import { executeMcp } from '../src/commerce/mcp-execution.js';
import { listServiceActions,prepareServiceAction,recoverServiceActions } from '../src/commerce/service-actions.js';
import { digest } from '../src/commerce/domain.js';
const url=process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const pool=new pg.Pool({connectionString:url});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const repository=new CommerceRepository(pool),commerce=new CommerceService(repository,[A,B],'test');
const endpoint='https://mcp.shippo.com/mcp',secret='k'.repeat(32);
const tool={name:'shippo_describe_tool',description:'Describe an operation',inputSchema:{type:'object',properties:{operation:{type:'string'}}}};
let calls=0,failAfterSend=false,changedSchema=false;
let waitOnList:Promise<void>|undefined,onList:(()=>void)|undefined;
let waitOnCall:Promise<void>|undefined,onCall:(()=>void)|undefined;
let expectedAction='';
const fetch:FetchLike=async(_url,init)=>{
  if(init?.method==='DELETE') return new Response(null,{status:200});
  if(init?.method==='GET') return new Response(null,{status:405});
  const msg=JSON.parse(String(init?.body));
  if(msg.id===undefined) return new Response(null,{status:202});
  if(msg.method==='tools/list') {onList?.();await waitOnList;}
  if(msg.method==='tools/call') {
    calls++;assert.equal((await pool.query('select state from pilot_service_actions where id=$1',[expectedAction])).rows[0].state,'running');
    onCall?.();await waitOnCall;if(failAfterSend) throw new Error('SECRET_REMOTE_ERROR');
  }
  const result=msg.method==='initialize'
    ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
    : msg.method==='tools/list' ? {tools:[changedSchema?{...tool,description:'changed'}:tool]}
    : {content:[{type:'text',text:'ACCESS_CANARY REFRESH_CANARY'}],structuredContent:{status:'QUEUED',id:'remote-receipt'}};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}),{headers:{'content-type':'application/json'}});
};
const connections=new CommerceConnections(commerce,secret,'https://app.tbd.com',undefined,undefined,
  (endpoint,invocation,before,_fetch,redact)=>executeMcp(endpoint,invocation,before,fetch,redact));
try {
  const e=await commerce.create(A,randomUUID(),{request:{item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Good'},privateBudget:937123});
  await commerce.command(A,e.id,randomUUID(),e.revision,{type:'share_request',requestDigest:e.requestDigest});
  const research=randomUUID(),connection=randomUUID(),generation=randomUUID();
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,approved_at,result)
    values($1,$2,$3,'test','inspect_mcp',$4,$5,'ready',now(),$6)`,[research,e.id,A,{url:endpoint,addressVersion:0},randomUUID(),{sources:[],mcp:{status:'authorization_required'}}]);
  const sealed=new ConnectionSecrets(secret).seal(JSON.stringify([connection,A,e.id,'test',endpoint]),{tokens:{access_token:'ACCESS_CANARY',refresh_token:'REFRESH_CANARY',token_type:'Bearer'}});
  const inspection={status:'inspected',transport:'streamable_http',authority:'untrusted_capabilities_only',tools:[tool],schemaDigest:digest([tool])};
  await pool.query(`insert into pilot_connections(id,exchange_id,owner_id,research_id,mode,endpoint,state,credentials,generation,inspection,access_expires_at)
    values($1,$2,$3,$4,'test',$5,'connected',$6,$7,$8,now()+interval '1 hour')`,[connection,e.id,A,research,endpoint,sealed,generation,inspection]);
  const input=async(operation:string)=>({action:'prepare_service_action' as const,exchangeId:e.id,connectionId:connection,
    revision:(await repository.get(e.id,A)).revision,tool:tool.name,arguments:{operation},explanation:'Read the operation contract before proceeding.'});
  const prepare=async(operation:string)=>prepareServiceAction(commerce,A,randomUUID(),await input(operation));
  const invoke=await input('CreateShipment'),turn=randomUUID();
  await commerce.invoke({userId:A,runId:randomUUID(),requestMessageId:turn},invoke);
  const first=(await listServiceActions(commerce,A,e.id))[0]!;
  assert.equal((await prepareServiceAction(commerce,A,turn,invoke)).id,first.id);
  await assert.rejects(prepareServiceAction(commerce,A,turn,{...invoke,arguments:{operation:'Different'}}),/already prepared/);
  assert.equal(calls,0);
  assert.deepEqual(await listServiceActions(commerce,B,e.id),[]);
  await assert.rejects(connections.decideAction(B,first.id,first.digest,true),/not found/);
  await assert.rejects(connections.decideAction(A,first.id,'f'.repeat(64),true),/changed/);
  await assert.rejects(prepareServiceAction(commerce,B,randomUUID(),invoke),/Connect and inspect/);
  await assert.rejects(prepareServiceAction(commerce,A,randomUUID(),{...invoke,tool:'invented'}),/Connect and inspect/);
  await assert.rejects(listServiceActions(new CommerceService(repository,[A,B],'live'),A,e.id),/not found/);
  await assert.rejects(prepareServiceAction(commerce,A,randomUUID(),{...invoke,arguments:{data:'x'.repeat(24001)}}),/too large/);
  expectedAction=first.id;
  let release!:()=>void;waitOnCall=new Promise(resolve=>{release=resolve;});
  const started=new Promise<void>(resolve=>{onCall=resolve;});
  const running=connections.decideAction(A,first.id,first.digest,true);await started;
  const replay=await connections.decideAction(A,first.id,first.digest,true);assert.equal(replay.state,'running');assert.equal(calls,1);
  release();const receipt=await running;waitOnCall=undefined;onCall=undefined;
  assert.equal(receipt.state,'returned');assert.equal(receipt.result?.structuredContent?.status,'QUEUED');
  assert(!JSON.stringify(receipt).includes('CANARY'));
  assert.equal((await connections.decideAction(A,first.id,first.digest,true)).state,'returned');assert.equal(calls,1);
  assert.equal((await prepare('CreateShipment')).id,first.id,'identical completed calls require reconciliation, not silent repetition');
  const newGeneration=randomUUID();await pool.query('update pilot_connections set generation=$2 where id=$1',[connection,newGeneration]);
  const redescribed=await prepare('CreateShipment');assert.notEqual(redescribed.id,first.id,'A new authorization needs current-generation descriptions');
  await pool.query("update pilot_service_actions set state='declined' where id=$1",[redescribed.id]);
  await pool.query('update pilot_connections set generation=$2 where id=$1',[connection,generation]);
  const state=await commerce.get(A,e.id);assert.equal(state.payment,'unpaid');assert.equal(state.shipping,'none');
  const agentState=await commerce.invoke({userId:B,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:e.id});
  assert(!JSON.stringify(agentState).includes('remote-receipt'));assert(!JSON.stringify(agentState).includes('937123'));
  const declined=await prepare('Decline');await connections.decideAction(A,declined.id,declined.digest,false);assert.equal(calls,1);
  assert.equal((await connections.decideAction(A,declined.id,declined.digest,true)).state,'declined');
  const stale=await prepare('Stale');
  await repository.transaction(async sql=>{const fresh=await repository.get(e.id,A,sql,true);await repository.save(sql,fresh,new Date());});
  await assert.rejects(connections.decideAction(A,stale.id,stale.digest,true),/changed/);
  const replacement=await prepare('Stale');assert.notEqual(replacement.id,stale.id);
  assert.equal((await listServiceActions(commerce,A,e.id)).find(a=>a.id===stale.id)?.state,'expired');
  const expired=await prepare('Expired');await pool.query("update pilot_service_actions set expires_at=now()-interval '1 second' where id=$1",[expired.id]);
  await assert.rejects(connections.decideAction(A,expired.id,expired.digest,true),/expired/);
  await recoverServiceActions(commerce);assert.equal((await listServiceActions(commerce,A,e.id)).find(a=>a.id===expired.id)?.state,'expired');
  const changed=await prepare('Changed');changedSchema=true;expectedAction=changed.id;
  assert.equal((await connections.decideAction(A,changed.id,changed.digest,true)).state,'failed');assert.equal(calls,1);changedSchema=false;
  const uncertain=await prepare('Ambiguous');expectedAction=uncertain.id;failAfterSend=true;
  assert.equal((await connections.decideAction(A,uncertain.id,uncertain.digest,true)).state,'uncertain');failAfterSend=false;assert.equal(calls,2);
  assert.equal((await prepare('Ambiguous')).id,uncertain.id);
  assert.equal((await connections.decideAction(A,uncertain.id,uncertain.digest,true)).state,'uncertain');assert.equal(calls,2);
  const crashed=await prepare('Crash');await pool.query("update pilot_service_actions set state='running',updated_at=now()-interval '2 minutes' where id=$1",[crashed.id]);
  await recoverServiceActions(commerce);assert.equal((await listServiceActions(commerce,A,e.id)).find(a=>a.id===crashed.id)?.state,'uncertain');
  const preflightCrash=await prepare('Preflight crash');await pool.query("update pilot_service_actions set state='verifying',updated_at=now()-interval '2 minutes' where id=$1",[preflightCrash.id]);
  await recoverServiceActions(commerce);assert.equal((await listServiceActions(commerce,A,e.id)).find(a=>a.id===preflightCrash.id)?.state,'expired');
  const expiredAccess=await prepare('Expired access');await pool.query("update pilot_connections set access_expires_at=now() where id=$1",[connection]);
  assert.equal((await connections.decideAction(A,expiredAccess.id,expiredAccess.digest,true)).state,'failed');assert.equal(calls,2);
  await pool.query("update pilot_connections set access_expires_at=now()+interval '1 hour' where id=$1",[connection]);
  const beforeRecovery=await repository.get(e.id,A);
  const recovery={...beforeRecovery,payment:'refunded' as const,stage:'cancelled' as const,cancellationRequested:true,problem:'Recover the original postage refund.'};
  await pool.query('update pilot_exchanges set data=$2 where id=$1',[e.id,recovery]);
  const recoveryDescription=await prepare('RefundRecovery');expectedAction=recoveryDescription.id;
  assert.equal((await connections.decideAction(A,recoveryDescription.id,recoveryDescription.digest,true)).state,'returned');assert.equal(calls,3);
  await pool.query('update pilot_exchanges set data=$2 where id=$1',[e.id,beforeRecovery]);
  const revoked=await prepare('Revoked');expectedAction=revoked.id;
  waitOnList=new Promise(resolve=>{release=resolve;});const listing=new Promise<void>(resolve=>{onList=resolve;});
  const pending=connections.decideAction(A,revoked.id,revoked.digest,true);await listing;
  await connections.disconnect(A,connection);release();
  assert.equal((await pending).state,'failed');assert.equal(calls,3);waitOnList=undefined;onList=undefined;
  await assert.rejects(prepare('Disconnected'),/Connect and inspect/);
  // Force timestamp ties to exercise stable cursor ordering without dropping
  // rows due to JS millisecond truncation or leaking another owner's cursor.
  await pool.query("update pilot_service_actions set created_at='2026-09-24T10:00:00.123456Z' where exchange_id=$1",[e.id]);
  const historyContext={userId:A,runId:randomUUID(),requestMessageId:randomUUID()};
  type Page={actions:{id:string}[];nextBeforeActionId:string|null};
  let page=await commerce.invoke(historyContext,{action:'service_history',exchangeId:e.id}) as Page;
  assert.equal(page.actions.length,5);assert(page.nextBeforeActionId);
  const seen:string[]=[];
  while(true) {
    seen.push(...page.actions.map(row=>row.id));
    assert(!JSON.stringify(page).includes('ACCESS_CANARY'));assert(!JSON.stringify(page).includes('937123'));
    if(!page.nextBeforeActionId) break;
    page=await commerce.invoke(historyContext,{action:'service_history',exchangeId:e.id,beforeActionId:page.nextBeforeActionId}) as Page;
  }
  const all=await listServiceActions(commerce,A,e.id);
  assert.deepEqual(seen,[...all].reverse().map(row=>row.id));assert.equal(new Set(seen).size,all.length);
  assert.deepEqual((await commerce.invoke({...historyContext,userId:B},{action:'service_history',exchangeId:e.id}) as Page).actions,[]);
  await assert.rejects(commerce.invoke({...historyContext,userId:B},{action:'service_history',exchangeId:e.id,beforeActionId:first.id}),/not found/);
  await assert.rejects(new CommerceService(repository,[A,B],'live').invoke(historyContext,{action:'service_history',exchangeId:e.id}),/not found/);
  await assert.rejects(commerce.invoke(historyContext,{action:'service_history',exchangeId:e.id,beforeActionId:randomUUID()}),/not found/);
  const historyState=await commerce.invoke(historyContext,{action:'state',exchangeId:e.id}) as {exchanges:{serviceActionHistoryCursor:string;serviceActions:{id:string}[]}[]};
  assert.equal(historyState.exchanges[0]!.serviceActions.length,5);
  assert.equal(historyState.exchanges[0]!.serviceActionHistoryCursor,all.at(-5)!.id);
  const messages=await pool.query("select count(*)::int n from pilot_messages where exchange_id=$1 and recipient_id=$2 and payload->>'action'='service_action_update'",[e.id,A]);
  assert(messages.rows[0].n>=10);
  for(const role of ['anon','authenticated']) {
    const sql=await pool.connect();try {await sql.query('begin');await sql.query(`set local role ${role}`);
      await assert.rejects(sql.query('select * from public.pilot_service_actions'),/permission denied/);
    } finally {await sql.query('rollback');sql.release();}
  }
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[e.id])).rows[0].n,0);
  process.stdout.write('PASS: exact owner review, SDK dispatch after durable claim, private receipts, duplicate/replay/stale/schema/mode/credential/revocation fences, crash uncertainty and RLS; no lifecycle claims or real provider calls.\n');
} finally {await pool.end();}
