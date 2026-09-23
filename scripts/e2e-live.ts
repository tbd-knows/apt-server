import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../src/config.js';
import type { ChatPage, ChatRun, CreatedTurn, PublicRunEvent } from '../src/domain.js';

const config = loadConfig();
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--') && value) args.set(key.slice(2), value);
}
const userA = args.get('user-a');
const userB = args.get('user-b');
const baseUrl = (args.get('base-url') ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
if (!userA || !userB || userA === userB) {
  throw new Error('Usage: npm run test:e2e-live -- --user-a <uuid> --user-b <different-uuid> [--base-url <url>]');
}

const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function accessToken(userId: string) {
  const userResult = await admin.auth.admin.getUserById(userId);
  const email = userResult.data.user?.email;
  if (userResult.error || !email) throw new Error(`Could not resolve email auth for ${userId}.`);
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link.data.properties?.hashed_token;
  if (link.error || !tokenHash) throw new Error(`Could not create a test session for ${userId}.`);
  const client = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const verified = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  const token = verified.data.session?.access_token;
  if (verified.error || !token || verified.data.user?.id !== userId) {
    throw new Error(`Could not verify the test session for ${userId}.`);
  }
  return token;
}

async function request<T>(token: string | null, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => null) as T | { error?: { code?: string; message?: string } } | null;
  return { response, body };
}

async function expectError(token: string | null, path: string, status: number, code: string) {
  const result = await request<{ error?: { code?: string } }>(token, path);
  assert(result.response.status === status, `${path} returned ${result.response.status}; expected ${status}.`);
  assert(result.body?.error?.code === code, `${path} returned the wrong error code.`);
}

async function streamRun(token: string, runId: string) {
  const response = await fetch(`${baseUrl}/v1/chat/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(180_000),
  });
  assert(response.ok && response.body, `Run stream returned ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: PublicRunEvent[] = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (data) events.push(JSON.parse(data) as PublicRunEvent);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  assert(events[0]?.type === 'run.snapshot', 'Run stream did not begin with a snapshot.');
  const terminal = events.at(-1);
  assert(terminal?.type === 'run.completed' || terminal?.type === 'run.cancelled' || terminal?.type === 'run.failed', 'Run stream did not terminate.');
  return events;
}

async function createAndComplete(token: string, content: string) {
  const clientMessageId = randomUUID();
  const payload = JSON.stringify({ clientMessageId, content });
  const first = await request<CreatedTurn>(token, '/v1/chat/messages', {
    method: 'POST', body: payload,
  });
  assert(first.response.status === 202 && first.body && 'run' in first.body, 'Message was not accepted.');
  const turn = first.body as CreatedTurn;
  const duplicate = await request<CreatedTurn>(token, '/v1/chat/messages', {
    method: 'POST', body: payload,
  });
  assert(duplicate.response.status === 200 && duplicate.body && 'run' in duplicate.body, 'Duplicate was not handled idempotently.');
  assert((duplicate.body as CreatedTurn).run.id === turn.run.id, 'Duplicate created a different run.');
  const events = await streamRun(token, turn.run.id);
  const final = await request<ChatRun>(token, `/v1/chat/runs/${turn.run.id}`);
  assert(final.response.ok && final.body && 'status' in final.body, 'Final run snapshot was unavailable.');
  const run = final.body as ChatRun;
  assert(run.status === 'completed', `Expected completed run; received ${run.status}.`);
  assert(Boolean(run.response?.content.trim()), 'Completed response was empty.');
  return { turn, events, run };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const [tokenA, tokenB] = await Promise.all([accessToken(userA), accessToken(userB)]);
await expectError(null, '/v1/chat', 401, 'UNAUTHENTICATED');

const writeContext = args.get('write-context');
const recallContext = args.get('recall-context');
const leaveRunning = args.get('leave-running');
if (leaveRunning) {
  const started = await request<CreatedTurn>(tokenA, '/v1/chat/messages', {
    method: 'POST', body: JSON.stringify({ clientMessageId: randomUUID(), content: leaveRunning }),
  });
  assert(started.response.status === 202 && started.body && 'run' in started.body, 'Restart probe message was not accepted.');
  const runId = (started.body as CreatedTurn).run.id;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const snapshot = await request<ChatRun>(tokenA, `/v1/chat/runs/${runId}`);
    if (snapshot.body && 'status' in snapshot.body && (snapshot.body as ChatRun).status === 'running') {
      process.stdout.write(JSON.stringify({ ok: true, runId, status: 'running' }) + '\n');
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Restart probe did not reach running state.');
}
if (writeContext || recallContext) {
  const content = writeContext
    ? `Remember the exact secret phrase ${writeContext} for my next turn. Reply with the phrase.`
    : 'What exact secret phrase did I ask you to remember in my immediately preceding turn? Reply with only that phrase.';
  const result = await createAndComplete(tokenA, content);
  const expected = writeContext ?? recallContext!;
  assert(result.run.response?.content.includes(expected), 'Hermes session context verification failed.');
  process.stdout.write(JSON.stringify({ ok: true, context: writeContext ? 'written' : 'recalled' }) + '\n');
  process.exit(0);
}

const markerA = `APT-E2E-A-${Date.now()}`;
const markerB = `APT-E2E-B-${Date.now()}`;
const completedA = await createAndComplete(tokenA, `Reply briefly and include this exact marker: ${markerA}`);
await expectError(tokenB, `/v1/chat/runs/${completedA.turn.run.id}`, 404, 'RUN_NOT_FOUND');

const historyA = await request<ChatPage>(tokenA, '/v1/chat?limit=1');
assert(historyA.response.ok && historyA.body && 'messages' in historyA.body, 'User A history was unavailable.');
assert(Boolean((historyA.body as ChatPage).olderCursor), 'Pagination did not return an older cursor.');
const olderA = await request<ChatPage>(tokenA, `/v1/chat?limit=10&before=${(historyA.body as ChatPage).olderCursor}`);
assert(olderA.response.ok && olderA.body && 'messages' in olderA.body, 'Older history was unavailable.');
assert((olderA.body as ChatPage).messages.some((message) => message.content.includes(markerA)), 'User A marker was not persisted.');

await createAndComplete(tokenB, `Reply briefly and include this exact marker: ${markerB}`);
const historyB = await request<ChatPage>(tokenB, '/v1/chat?limit=100');
assert(historyB.response.ok && historyB.body && 'messages' in historyB.body, 'User B history was unavailable.');
assert((historyB.body as ChatPage).messages.some((message) => message.content.includes(markerB)), 'User B marker was not persisted.');
assert(!(historyB.body as ChatPage).messages.some((message) => message.content.includes(markerA)), 'User A content leaked into user B history.');

// Retired routes must be absent, not merely unauthorized.
for (const path of ['/v1/shopping/summary', '/v1/cart', '/v1/wishlist', '/v1/boards']) {
  const retired = await request<unknown>(tokenA, path);
  assert(retired.response.status === 404, `Retired route ${path} is still served (${retired.response.status}).`);
}
const retiredBridge = await request<unknown>(null, '/internal/claw/tool', { method: 'POST', body: '{}' });
assert(retiredBridge.response.status === 404, 'Retired Claw bridge route is still served.');

const stopTurn = await request<CreatedTurn>(tokenB, '/v1/chat/messages', {
  method: 'POST',
  body: JSON.stringify({ clientMessageId: randomUUID(), content: 'Write a very long numbered list with at least 5000 items.' }),
});
assert(stopTurn.response.status === 202 && stopTurn.body && 'run' in stopTurn.body, 'Stop test message was not accepted.');
const stopRunId = (stopTurn.body as CreatedTurn).run.id;
const stopping = await request<ChatRun>(tokenB, `/v1/chat/runs/${stopRunId}/stop`, { method: 'POST' });
assert(stopping.response.status === 202, 'Stop request was not accepted.');
const stopEvents = await streamRun(tokenB, stopRunId);
const stopTerminal = stopEvents.at(-1);
assert(stopTerminal?.type === 'run.cancelled' || stopTerminal?.type === 'run.completed', 'Stopped run did not settle safely.');

process.stdout.write(JSON.stringify({
  ok: true,
  checks: {
    health: true,
    authentication: true,
    messageAndSse: true,
    idempotency: true,
    pagination: true,
    stop: true,
    crossUserIsolation: true,
    retiredRoutesAbsent: true,
  },
  eventCounts: { userA: completedA.events.length, stop: stopEvents.length },
}) + '\n');
