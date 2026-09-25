/** Real database, SDK OAuth, deterministic provider responses. No real account. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {CommerceRepository} from '../src/commerce/repository.js';
import {CommerceService} from '../src/commerce/service.js';
import {CommerceConnections,listConnections,recoverConnections} from '../src/commerce/connections.js';
import {ConnectionOAuth} from '../src/commerce/connection-oauth.js';
import type {McpInspection} from '../src/commerce/mcp-inspection.js';
const url=process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname));
const pool=new pg.Pool({connectionString:url});
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const service=new CommerceService(new CommerceRepository(pool),[A,B],'test');
const endpoint='https://mcp.vendor.com/mcp',issuer='https://login.vendor.com/';
let exchanges=0,refreshes=0,inspections=0;
let waitForExchange:Promise<void>|undefined;
let tokenRequestStarted:(()=>void)|undefined;
let failRefresh=false;
let omitRefreshMetadata=false,catalogChanged=false;
const oauth=new ConnectionOAuth(async(url,init)=>{
  const href=String(url);
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  if(href.includes('oauth-protected-resource')) return json({resource:endpoint,authorization_servers:[issuer],scopes_supported:['shipping:read']});
  if(href.includes('oauth-authorization-server')) return json({issuer,authorization_endpoint:`${issuer}authorize`,token_endpoint:`${issuer}token`,
    response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],client_id_metadata_document_supported:true});
  assert.equal(href,`${issuer}token`);
  const input=new URLSearchParams(String(init?.body));assert.equal(input.get('resource'),endpoint);
  if(input.get('grant_type')==='refresh_token') {refreshes++;assert.equal(input.get('refresh_token'),'REFRESH_CANARY');if(failRefresh) return json({error:'invalid_grant',error_description:'SECRET_PROVIDER_ERROR'},400);}
  else {exchanges++;assert(input.get('code_verifier'));assert.equal(input.get('code'),'CODE_CANARY');}
  tokenRequestStarted?.();await waitForExchange;
  return json({access_token:'ACCESS_CANARY',token_type:'Bearer',expires_in:3600,
    ...(input.get('grant_type')==='refresh_token' && omitRefreshMetadata ? {} : {refresh_token:'REFRESH_CANARY',scope:'shipping:read'})});
});
const inspect=async(url:string,token:string):Promise<McpInspection>=>{
  inspections++;assert.equal(url,endpoint);assert.equal(token,'ACCESS_CANARY');
  return {status:'inspected',transport:'streamable_http',authority:'untrusted_capabilities_only',schemaDigest:'f'.repeat(64),
    tools:[{name:'track_package',description:catalogChanged?'Changed capability':'Untrusted remote echo ACCESS_CANARY',inputSchema:{type:'object'}}]};
};
const connections=()=>new CommerceConnections(service,'k'.repeat(32),'https://app.tbd.com',oauth,inspect);
try {
  const draft=await service.create(A,randomUUID(),{request:{item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Good'},privateBudget:937123});
  const researchId=randomUUID();
  // Protocol inspection approval itself is covered by mcp-inspection-db-check.
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,approved_at,result)
    values($1,$2,$3,'test','inspect_mcp',$4,$5,'ready',now(),$6)`,[researchId,draft.id,A,{url:endpoint,addressVersion:0},randomUUID(),
    {sources:[],checkedAt:new Date().toISOString(),verifiedForFulfillment:false,mcp:{status:'authorization_required'}}]);
  await assert.rejects(connections().prepare(B,draft.id,researchId),/not found/);
  const [prepared,replayed]=await Promise.all([connections().prepare(A,draft.id,researchId),connections().prepare(A,draft.id,researchId)]);
  assert.equal(prepared.id,replayed.id);assert.equal(prepared.state,'review');
  assert.equal(exchanges,0);
  await assert.rejects(connections().start(B,prepared.id,prepared.bindingDigest!),/not found/);
  await assert.rejects(connections().start(A,prepared.id,'f'.repeat(64)),/changed/);
  const started=await connections().start(A,prepared.id,prepared.bindingDigest!);
  const state=new URL(started.url!).searchParams.get('state')!;
  assert.equal((await connections().start(A,prepared.id,prepared.bindingDigest!)).url,started.url,'Retry should reuse browser flow');
  assert.equal(await connections().callback('x'.repeat(43),'CODE_CANARY'),false);assert.equal(exchanges,0);
  const pending=(await pool.query('select credentials,state_hash from pilot_connections where id=$1',[prepared.id])).rows[0];
  assert(!pending.credentials.includes('codeVerifier'));assert.notEqual(pending.state_hash,state);
  // Fresh service instance survives the browser wait and restart.
  assert.equal(await connections().callback(state,'CODE_CANARY'),true);
  assert.equal(await connections().callback(state,'CODE_CANARY'),false);assert.equal(exchanges,1);assert.equal(inspections,1);
  const owner=await listConnections(service,A,draft.id);
  assert.equal(owner[0]!.state,'connected');
  assert(!JSON.stringify(owner).includes('ACCESS_CANARY'));assert(!JSON.stringify(owner).includes('REFRESH_CANARY'));
  const agent=await service.invoke({userId:A,runId:randomUUID(),requestMessageId:randomUUID()},{action:'state',exchangeId:draft.id});
  assert(!JSON.stringify(agent).includes('ACCESS_CANARY'));assert(!JSON.stringify(agent).includes('CODE_CANARY'));
  const e=await service.get(A,draft.id);
  await service.command(A,e.id,randomUUID(),e.revision,{type:'share_request',requestDigest:e.requestDigest});
  assert.deepEqual(await listConnections(service,B,draft.id),[]);
  const live=new CommerceConnections(new CommerceService(service.repository,[A,B],'live'),'k'.repeat(32),'https://app.tbd.com',oauth,inspect);
  await assert.rejects(live.recheck(A,prepared.id),/not found/);
  const stored=(await pool.query('select credentials from pilot_connections where id=$1',[prepared.id])).rows[0].credentials;
  assert(!stored.includes('ACCESS_CANARY'));assert(!stored.includes('REFRESH_CANARY'));
  const generation=async()=>(await pool.query('select generation from pilot_connections where id=$1',[prepared.id])).rows[0].generation;
  const originalGeneration=await generation();
  await pool.query("update pilot_connections set access_expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  assert.equal((await connections().recheck(A,prepared.id)).state,'connected');assert.equal(refreshes,1);
  assert.equal(await generation(),originalGeneration,'Same grant/catalog refresh must not invalidate exact approvals');
  await connections().recheck(A,prepared.id);assert.equal(refreshes,1);assert.equal(await generation(),originalGeneration);
  // Automatic maintenance retains an omitted non-rotated refresh token and
  // scope, allowing the next refresh without another browser login.
  omitRefreshMetadata=true;
  await pool.query("update pilot_connections set access_expires_at=now()+interval '30 seconds' where id=$1",[prepared.id]);
  await connections().renewExpiring();assert.equal(refreshes,2);assert.equal(await generation(),originalGeneration);
  await pool.query("update pilot_connections set access_expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  await connections().renewExpiring();assert.equal(refreshes,3);assert.equal(await generation(),originalGeneration);
  omitRefreshMetadata=false;
  catalogChanged=true;await connections().recheck(A,prepared.id);
  assert.notEqual(await generation(),originalGeneration,'Changed capabilities must invalidate old authority');catalogChanged=false;
  await connections().recheck(A,prepared.id);
  // Concurrent refreshes have one lease; disconnect fences a late token and
  // inspection response even when its predecessor generation was approved.
  await pool.query("update pilot_connections set access_expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  let finishRefresh!:()=>void;
  waitForExchange=new Promise<void>(resolve=>{finishRefresh=resolve;});
  const refreshStarted=new Promise<void>(resolve=>{tokenRequestStarted=resolve;});
  const refreshing=connections().recheck(A,prepared.id);await refreshStarted;
  await assert.rejects(connections().recheck(A,prepared.id),/Finish or restart/);
  const inFlightGeneration=await generation();await connections().disconnect(A,prepared.id);finishRefresh();await refreshing;
  assert.equal((await listConnections(service,A,draft.id))[0]!.state,'revoked');assert.notEqual(await generation(),inFlightGeneration);
  waitForExchange=undefined;tokenRequestStarted=undefined;
  const refreshedReview=await connections().prepare(A,draft.id,researchId);
  const refreshedStart=await connections().start(A,prepared.id,refreshedReview.bindingDigest!);
  assert.equal(await connections().callback(new URL(refreshedStart.url!).searchParams.get('state')!,'CODE_CANARY'),true);
  failRefresh=true;
  await pool.query("update pilot_connections set access_expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  assert.equal((await connections().recheck(A,prepared.id)).state,'reconnect_required');
  assert(!JSON.stringify(await listConnections(service,A,draft.id)).includes('SECRET_PROVIDER_ERROR'));
  failRefresh=false;
  const denied=await connections().start(A,prepared.id,prepared.bindingDigest!);
  assert.equal(await connections().callback(new URL(denied.url!).searchParams.get('state')!,undefined,true),false);
  assert.equal((await listConnections(service,A,draft.id))[0]!.state,'failed');
  // A late token response cannot resurrect a disconnected connection.
  const race=await connections().start(A,prepared.id,prepared.bindingDigest!);
  let release:()=>void;
  waitForExchange=new Promise<void>(resolve=>{release=resolve;});
  const waiting=new Promise<void>(resolve=>{tokenRequestStarted=resolve;});
  const callback=connections().callback(new URL(race.url!).searchParams.get('state')!,'CODE_CANARY');
  await waiting;await connections().disconnect(A,prepared.id);release!();await callback;
  const disconnected=(await pool.query('select state,credentials,state_hash from pilot_connections where id=$1',[prepared.id])).rows[0];
  assert.deepEqual(disconnected,{state:'revoked',credentials:null,state_hash:null});
  await assert.rejects(connections().recheck(A,prepared.id),/Finish or restart/);
  waitForExchange=undefined;tokenRequestStarted=undefined;
  const restored=await connections().prepare(A,draft.id,researchId);assert.equal(restored.state,'review');
  const expired=await connections().start(A,prepared.id,restored.bindingDigest!);
  await pool.query("update pilot_connections set expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  const count=exchanges;
  assert.equal(await connections().callback(new URL(expired.url!).searchParams.get('state')!,'CODE_CANARY'),false);assert.equal(exchanges,count);
  await recoverConnections(service);
  assert.equal((await listConnections(service,A,draft.id))[0]!.state,'reconnect_required');
  const wakes=await pool.query("select count(*)::int n from pilot_messages where exchange_id=$1 and payload->>'action'='connection_update'",[draft.id]);
  await recoverConnections(service);
  assert.equal((await pool.query("select count(*)::int n from pilot_messages where exchange_id=$1 and payload->>'action'='connection_update'",[draft.id])).rows[0].n,wakes.rows[0].n);
  // An expired refresh lease has an unknown outcome. It must never replay the
  // old refresh token, even if the process was interrupted before persistence.
  await pool.query("update pilot_connections set state='exchanging',expires_at=now()-interval '1 minute' where id=$1",[prepared.id]);
  const beforeRecoveryRefreshes=refreshes;
  await assert.rejects(connections().recheck(A,prepared.id),/Finish or restart/);
  await connections().renewExpiring();assert.equal(refreshes,beforeRecoveryRefreshes);
  await recoverConnections(service);
  assert.equal((await listConnections(service,A,draft.id))[0]!.state,'reconnect_required');
  // Paid-order recovery belongs only to the original seller's bound account.
  // Use a separate fixture so the buyer-owned discovery above cannot inherit
  // this authority merely by being a participant in the order.
  const recovery=await service.create(B,randomUUID(),{request:{item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Good'},privateBudget:937123});
  await service.command(B,recovery.id,randomUUID(),recovery.revision,{type:'share_request',requestDigest:recovery.requestDigest});
  const recoveryResearch=randomUUID();
  await pool.query(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state,approved_at,result)
    values($1,$2,$3,'test','inspect_mcp',$4,$5,'ready',now(),$6)`,[recoveryResearch,recovery.id,A,{url:endpoint,addressVersion:0},randomUUID(),
    {sources:[],checkedAt:new Date().toISOString(),verifiedForFulfillment:false,mcp:{status:'authorization_required'}}]);
  const recoveryConnection=await connections().prepare(A,recovery.id,recoveryResearch);
  await pool.query(`update pilot_exchanges set data=data||$2::jsonb where id=$1`,[recovery.id,
    {payment:'refunded',stage:'cancelled',cancellationRequested:true,offers:[{version:1,item:{sellerAmount:1000},quote:{shippingAmount:500},
      taxAmount:0,feeAmount:0,buyerTotal:1500,currency:'USD',postageFunding:'seller_reimbursed',
      connectedShipping:{authorizationId:'fixture-bound-authority'}}]}]);
  await assert.rejects(connections().start(A,recoveryConnection.id,recoveryConnection.bindingDigest!),/cannot be changed/);
  await service.repository.transaction(async sql=>{
    const order=await service.repository.get(recovery.id,A,sql);
    const input=await service.repository.privateInput(order,A,sql);
    await sql.query(`insert into pilot_private_inputs(exchange_id,owner_id,data) values($1,$2,$3)
      on conflict(exchange_id,owner_id) do update set data=excluded.data`,[order.id,A,{...input,discoveryVersion:99,
      connectedShipping:{'1':{connectionId:recoveryConnection.id,authorizationId:'fixture-bound-authority'}}}]);
  });
  const recoveryStart=await connections().start(A,recoveryConnection.id,recoveryConnection.bindingDigest!);
  assert.equal(await connections().callback(new URL(recoveryStart.url!).searchParams.get('state')!,'CODE_CANARY'),true);
  await connections().disconnect(A,recoveryConnection.id);
  assert.equal((await connections().prepare(A,recovery.id,recoveryResearch)).state,'review');
  await assert.rejects(connections().prepare(B,recovery.id,recoveryResearch),/cannot be changed/);
  const protection=await pool.query("select relrowsecurity,relforcerowsecurity,has_table_privilege('authenticated','public.pilot_connections','select') as client from pg_class where oid='public.pilot_connections'::regclass");
  assert.deepEqual(protection.rows[0],{relrowsecurity:true,relforcerowsecurity:true,client:false});
  assert.equal((await pool.query('select count(*)::int n from pilot_operations where exchange_id=$1',[draft.id])).rows[0].n,0);
  process.stdout.write('PASS: durable owner-bound OAuth/PKCE, exact approval, replay/expiry/mode/private denial, encrypted credentials, token reflection removal, refresh/failure recovery, disconnect race, forced RLS and no purchase side effects.\n');
} finally {await pool.end();}
