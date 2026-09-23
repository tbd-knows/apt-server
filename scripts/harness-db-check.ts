/** Real disposable Postgres; exercises agent preparations without a model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';

const url = process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(url) && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname), 'Disposable loopback database required');
const pool = new pg.Pool({ connectionString: url });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const repository = new CommerceRepository(pool);
let now = new Date();
const service = () => new CommerceService(repository, [A,B], 'test', () => now);
const context = (actor: string) => ({ userId: actor, runId: randomUUID(), requestMessageId: randomUUID() });
const run = async (actor: string, id: string, command: unknown) => {
  const view = await service().get(actor,id);
  return service().command(actor,id,randomUUID(),view.revision,command);
};
const prepare = async (actor: string, id: string, command: unknown, ownerContext = context(actor)) => {
  const view = await service().get(actor,id);
  const input = { action: 'prepare_action', exchangeId: id, revision: view.revision, command, explanation: 'Help resolve the next step.' };
  await service().invoke(ownerContext,input);
  return { input, ownerContext, view: await service().get(actor,id) };
};
try {
  const draft = await service().create(A,randomUUID(), { request: { item: 'Nike Air Force 1', style: 'White low', size: '10', sizingSystem: 'US men', condition: 'Used good' }, privateBudget: 937123 });
  await run(A,draft.id,{type:'share_request',requestDigest:draft.requestDigest});
  let result = await prepare(B,draft.id,{type:'message',kind:'question',text:'Is light sole wear acceptable?'});
  let action = result.view.privateInput.agentAction!;
  assert(action && action.revision === result.view.revision);
  assert(!(await service().inbox(A)).some(m=>m.payload.text==='Is light sole wear acceptable?'), 'Draft was shared without approval');
  assert.equal((await service().get(A,draft.id)).privateInput.agentAction, undefined, 'Counterparty received private draft');
  await service().invoke(result.ownerContext,result.input); // Same tool replay, same draft.
  assert.equal((await service().get(B,draft.id)).privateInput.agentAction?.id,action.id);
  await assert.rejects(service().invoke(result.ownerContext,{...result.input,explanation:'Try another draft in the same turn'}),/different input/);
  await assert.rejects(run(A,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest}),/changed or expired/);
  await assert.rejects(run(B,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:'f'.repeat(64)}),/changed or expired/);
  // A separate service instance sees the persisted review after a human wait.
  const approved = await run(B,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest});
  assert.equal(approved.privateInput.agentAction,undefined);
  assert.equal((await service().inbox(A)).filter(m=>m.payload.text==='Is light sole wear acceptable?').length,1);
  await assert.rejects(run(B,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest}),/changed or expired/);
  const sellerState = await service().invoke(context(B),{action:'state',exchangeId:draft.id});
  assert(!JSON.stringify(sellerState).includes('937123'));
  assert(JSON.stringify(sellerState).includes('ask_owner_about_item'));
  result = await prepare(B,draft.id,{type:'decline',reason:'I do not own a suitable pair'});
  action = result.view.privateInput.agentAction!;
  await run(A,draft.id,{type:'message',kind:'answer',text:'Light wear is acceptable.'});
  await assert.rejects(run(B,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest}),/changed or expired/);
  await run(B,draft.id,{type:'dismiss_agent_action',actionId:action.id});
  result = await prepare(B,draft.id,{type:'decline',reason:'I do not own a suitable pair'});
  action = result.view.privateInput.agentAction!;
  now = new Date(now.getTime()+25*60*60_000);
  await assert.rejects(run(B,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest}),/changed or expired/);
  now = new Date();
  await run(B,draft.id,{type:'dismiss_agent_action',actionId:action.id});
  const emptyCheckout = await prepare(A,draft.id,{type:'checkout'});
  action = emptyCheckout.view.privateInput.agentAction!;
  await assert.rejects(run(A,draft.id,{type:'approve_agent_action',actionId:action.id,actionDigest:action.digest}),/quote and offer/);
  assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='checkout'",[draft.id])).rows[0].n,0);
  await assert.rejects(prepare(A,draft.id,{type:'approve',binding:{amount:1}}));
  await assert.rejects(prepare(A,draft.id,{type:'mark_paid'}));
  assert((await service().pendingAgentMessages()).some(m=>m.recipient_id===B));
  process.stdout.write('PASS: private durable agent actions, owner-only exact approval, stale/expired/replay denial, one draft per turn, normal payment guards and owner resume.\n');
} finally { await pool.end(); }
