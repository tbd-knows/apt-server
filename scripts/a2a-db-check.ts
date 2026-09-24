/** Disposable Postgres authorization and recovery checks; no network/model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { CommerceA2A } from '../src/commerce/a2a.js';
import { CommerceRepository } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';

const databaseUrl = process.env.APT_LOCAL_DATABASE_URL ?? '';
assert(URL.canParse(databaseUrl) && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname), 'Disposable loopback database required');
const pool = new pg.Pool({ connectionString: databaseUrl });
const actors = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const profiles = ['apt-aaaaaaaaaaaaaaaaaaaa', 'apt-bbbbbbbbbbbbbbbbbbbb'];
const config = loadConfig({ APT_PILOT_USER_IDS: actors.join(','), SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-fixture-only', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture-only-key',
  SUPABASE_DATABASE_URL: databaseUrl, HERMES_KEY_SECRET: 'fixture-only-key-not-production-1234', HERMES_MODEL: 'fixture', HERMES_PROVIDER_API_KEY: 'fixture' });
const commerce = new CommerceService(new CommerceRepository(pool), actors, 'test');
const transport = new CommerceA2A(commerce, config.hermes);
try {
  const draft = await commerce.create(actors[0]!, randomUUID(), { request: { item: 'Nike Air Force 1', style: 'White low', size: '10', sizingSystem: 'US men', condition: 'Used good' }, privateBudget: 937123 });
  // Private, unapproved drafts cannot cross the transport boundary.
  const privateId = (await pool.query('select id from pilot_messages where exchange_id=$1', [draft.id])).rows[0].id;
  await assert.rejects(transport.receive(profiles[1]!, { messageId: privateId, contextId: privateId, peer: profiles[0], taskId: 'unauthorized' }), /not found/);
  await commerce.command(actors[0]!, draft.id, randomUUID(), draft.revision, { type: 'share_request', requestDigest: draft.requestDigest });
  const messageId = (await pool.query('select id from pilot_messages where exchange_id=$1 and sender_id<>recipient_id', [draft.id])).rows[0].id;
  // Exercise the real lease query, tolerating other disposable fixture outboxes.
  for (let n=0;n<100;n++) {
    const leased = (await transport.outbox(profiles[0]!)).messages[0];
    assert(leased, 'Expected an approved outgoing message');
    assert(!JSON.stringify(leased).includes('937123'));
    if (leased.messageId === messageId) break;
    await transport.receive(profiles[1]!, { messageId: leased.messageId, contextId: leased.messageId, peer: profiles[0], taskId: 'fixture-prior' });
    assert(n<99, 'Fixture outbox too large');
  }
  assert(!(await transport.outbox(profiles[0]!)).messages.some(m=>m.messageId===messageId), 'Lease must prevent immediate repeated delivery');
  await pool.query("update pilot_messages set a2a_attempts=5,a2a_attempted_at=now()-interval '2 minutes' where id=$1", [messageId]);
  assert.equal((await commerce.get(actors[0]!, draft.id)).deliveries.find(m=>m.id===messageId)?.state, 'needs_attention');
  let view = await commerce.get(actors[1]!, draft.id);
  await assert.rejects(commerce.command(actors[1]!, draft.id, randomUUID(), view.revision, { type: 'retry_delivery', messageId }), /Only your stalled/);
  view = await commerce.get(actors[0]!, draft.id);
  await commerce.command(actors[0]!, draft.id, randomUUID(), view.revision, { type: 'retry_delivery', messageId });
  assert.equal((await transport.outbox(profiles[0]!)).messages[0]?.messageId, messageId);
  assert(!(await commerce.pendingAgentMessages()).some(m=>m.id===messageId));
  const receipt = { messageId, contextId: messageId, peer: profiles[0], taskId: 'first-task' };
  await assert.rejects(transport.receive(profiles[0]!, { ...receipt, peer: profiles[1] }), /not found/);
  await assert.rejects(transport.receive(profiles[1]!, { ...receipt, contextId: randomUUID() }), /not found/);
  const live = new CommerceA2A(new CommerceService(commerce.repository, actors, 'live'), config.hermes);
  await assert.rejects(live.receive(profiles[1]!, receipt), /not found/);
  await transport.receive(profiles[1]!, receipt);
  await transport.receive(profiles[1]!, { ...receipt, taskId: 'replay' });
  assert.equal((await pool.query('select a2a_task_id from pilot_messages where id=$1', [messageId])).rows[0].a2a_task_id, 'first-task');
  // The fair scheduler returns one oldest wake per owner, so acknowledge prior
  // disposable-fixture wakes before asserting this newly received message.
  let reached = false;
  for (let n=0;n<100;n++) {
    const pending = (await commerce.pendingAgentMessages()).find(m=>m.recipient_id===actors[1]);
    assert(pending, 'Expected a received message to remain queued');
    if (pending.id===messageId) { reached=true; break; }
    await commerce.markAgentDelivered(pending.id);
  }
  assert(reached, 'Received message was starved by older fixture notifications');
  assert.equal((await commerce.get(actors[0]!, draft.id)).deliveries.find(m=>m.id===messageId)?.state, 'received');
  assert.deepEqual((await commerce.get(actors[1]!, draft.id)).deliveries, []);
  process.stdout.write('PASS: A2A authorization, mode/owner isolation, leases, bounded retry, receipt replay and durable wake eligibility.\n');
} finally {
  await pool.end();
}
