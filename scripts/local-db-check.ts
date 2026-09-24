/**
 * Upgrade-shaped fixture check against a DISPOSABLE local PostgreSQL.
 *
 *   docker run -d --name tbd-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine
 *   npm run test:local-db -- --database-url postgresql://postgres:pw@127.0.0.1:55432/postgres
 *
 * It drops and recreates the public schema, installs a minimal Supabase shim
 * (auth schema, roles, extensions schema), replays every migration unchanged,
 * seeds pre-pivot data in the retired tables plus private memory for two
 * founders, then drives the purged server through a fake Hermes runtime.
 * It refuses any database URL that is not loopback.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AgentRuntime, AgentRuntimeEvent, AgentSubmitOptions } from '../src/agent-runtime.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { AgentInstance } from '../src/domain.js';
import { AppError } from '../src/errors.js';
import { PostgresChatRepository } from '../src/repository.js';
import { aptBridgeToken } from '../src/memory/bridge-auth.js';
import { MemoryMaterializer } from '../src/memory/materializer.js';
import { PostgresMemoryRepository } from '../src/memory/repository.js';
import { MemoryAgentRuntime } from '../src/memory/runtime.js';
import { MemoryService } from '../src/memory/service.js';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--') && value) args.set(key.slice(2), value);
}
const databaseUrl = args.get('database-url') ?? process.env.APT_LOCAL_DATABASE_URL ?? '';
const parsedUrl = URL.canParse(databaseUrl) ? new URL(databaseUrl) : null;
if (!parsedUrl || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsedUrl.hostname)) {
  throw new Error('Usage: npm run test:local-db -- --database-url postgresql://user:pass@127.0.0.1:port/db (loopback only; the schema is dropped).');
}

const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const PROFILE_A = 'apt-aaaaaaaaaaaaaaaaaaaa';
const PROFILE_B = 'apt-bbbbbbbbbbbbbbbbbbbb';
const HISTORY = ['I wear US 10 and like white sneakers', 'Noted: size 10, white sneakers.'];

const config = loadConfig({
  APT_PILOT_USER_IDS: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  NODE_ENV: 'test', LOG_LEVEL: 'error', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-tests', SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  SUPABASE_DATABASE_URL: databaseUrl, SUPABASE_DATABASE_SSL: 'false', HERMES_KEY_SECRET: 'k'.repeat(32),
  HERMES_MODEL: 'test', HERMES_PROVIDER_API_KEY: 'test-key',
});
const sql = new pg.Pool({ connectionString: databaseUrl, max: 2 });

async function resetDatabase() {
  await sql.query('drop schema if exists public cascade; create schema public;');
  await sql.query(`
    create schema if not exists auth;
    create schema if not exists extensions;
    create table if not exists auth.users (id uuid primary key, email text);
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
    end $$;
    create extension if not exists pgcrypto with schema extensions;
    create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    delete from auth.users;
  `);
  const directory = join(serverDirectory, 'supabase', 'migrations');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  assert.equal(files.length, 12, 'Expected six historical migrations plus pilot, A2A, research, inspection, connection and service action migrations.');
  for (const file of files) await sql.query(await readFile(join(directory, file), 'utf8'));
  return files;
}

async function seedPrePivotData() {
  const statements: Array<[string, unknown[]]> = [
    [`insert into auth.users(id, email) values ($1, 'a@example.com'), ($2, 'b@example.com')`, [A, B]],
    [`insert into public.agent_instances(user_id, hermes_profile_name, hermes_session_id) values
        ($1, $3, '66666666-6666-4666-8666-666666666666'), ($2, $4, '77777777-7777-4777-8777-777777777777')`, [A, B, PROFILE_A, PROFILE_B]],
    [`with req as (
        insert into public.messages(user_id, role, content, status, client_message_id, completed_at)
        values ($1, 'user', $2, 'completed', gen_random_uuid(), now()) returning id
      ), res as (
        insert into public.messages(user_id, role, content, status, reply_to_message_id, completed_at)
        select $1, 'assistant', $3, 'completed', id, now() from req returning id
      )
      insert into public.agent_runs(user_id, request_message_id, response_message_id, status, finished_at, claw_mode)
      select $1, req.id, res.id, 'completed', now(), 'hunt' from req, res`, [A, HISTORY[0], HISTORY[1]]],
    [`insert into public.claw_user_profiles(user_id, soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash)
      values ($1, 'A soul: be concise', 'A user cache', 'A memory cache', 3, 1, repeat('a', 64)),
             ($2, 'B soul: be warm', 'B user cache', 'B memory cache', 2, 1, null)`, [A, B]],
    [`insert into public.claw_user_knowledge(user_id, subject_kind, subject_label, category, fact, confidence)
      values ($1, 'self', null, 'sizing', 'A-SECRET wears US men''s 10', 0.9),
             ($2, 'self', null, 'sizing', 'B-SECRET wears US men''s 9', 0.9)`, [A, B]],
    [`insert into public.claw_user_skills(user_id, key, title, content, checksum)
      values ($1, 'private.gifts', 'Gifts', E'---\\nname: private.gifts\\ndescription: x\\n---\\n# gifts', repeat('b', 64))`, [A]],
    [`insert into public.claw_admins(user_id) values ($1)`, [A]],
    [`insert into public.claw_releases(id, version, name, status, created_by, revision)
      values ('99999999-9999-4999-8999-999999999999', 1, 'Release 1', 'draft', $1, 1)`, [A]],
    [`with r as (select id as run_id, request_message_id from public.agent_runs where user_id = $1 limit 1)
      insert into public.commerce_hunts(user_id, agent_run_id, request_message_id, category, status, query, candidates, source_urls, completed_at)
      select $1, run_id, request_message_id, 'retail', 'completed', '{"goal":"sneakers"}', '[]', '[]', now() from r`, [A]],
  ];
  for (const [statement, values] of statements) await sql.query(statement, values);
}

const submissions: Array<{ instance: AgentInstance; input: string; options: AgentSubmitOptions | undefined }> = [];
let duringSubmit: ((instance: AgentInstance) => Promise<void>) | null = null;
let slow = false;
const stops: string[] = [];
let counter = 0;
const inner: AgentRuntime = {
  async submit(instance, input, options) {
    submissions.push({ instance, input, options });
    if (duringSubmit) await duringSubmit(instance);
    return { runId: `hermes-${counter += 1}` };
  },
  async getState() { return { status: 'completed', output: 'done' }; },
  async *stream(): AsyncIterable<AgentRuntimeEvent> {
    yield { type: 'delta', delta: 'hello ' };
    if (slow) {
      for (let index = 0; index < 100; index += 1) {
        if (stops.length) { yield { type: 'cancelled' }; return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    yield { type: 'delta', delta: 'world' };
    yield { type: 'completed', output: 'hello world' };
  },
  async stop(_instance, runId) { stops.push(runId); },
  async health() { /* ok */ },
};

async function build(hermesHome: string) {
  const repository = PostgresChatRepository.create(databaseUrl, false);
  const memoryRepository = PostgresMemoryRepository.create(databaseUrl, false);
  const memoryService = new MemoryService(memoryRepository);
  const runtime = new MemoryAgentRuntime(inner, memoryService, new MemoryMaterializer(hermesHome));
  const app = await buildApp({
    config, repository, runtime, memoryService,
    auth: { async authenticate(token) {
      if (token === 'a') return { id: A };
      if (token === 'b') return { id: B };
      if (token === 'c') return { id: C };
      throw new AppError('UNAUTHENTICATED', 'A valid token is required.');
    } },
  });
  app.addHook('onClose', async () => memoryRepository.close());
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof build>>;
type Frame = { type: string; run?: { status: string; response?: { content: string } } };

async function sse(app: App, token: string, runId: string) {
  const response = await app.inject({ method: 'GET', url: `/v1/chat/runs/${runId}/events`, headers: { authorization: `Bearer ${token}` } });
  return response.body.split('\n\n').filter(Boolean)
    .map((frame) => JSON.parse(frame.split('\n').find((line) => line.startsWith('data:'))!.slice(5)) as Frame);
}

async function send(app: App, token: string, clientMessageId: string, content: string) {
  const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: `Bearer ${token}` }, payload: { clientMessageId, content } });
  assert.equal(response.statusCode, 202, response.body);
  return response.json().run.id as string;
}

async function retiredCounts() {
  const tables = ['commerce_hunts', 'shopping_items', 'shopping_boards', 'claw_releases', 'claw_user_skills', 'claw_admins', 'claw_learning_proposals'];
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = Number((await sql.query(`select count(*) from public.${table}`)).rows[0].count);
  result.historical_messages = Number((await sql.query('select count(*) from public.messages where content = any($1)', [HISTORY])).rows[0].count);
  return result;
}

const hermesHome = await mkdtemp(join(tmpdir(), 'apt-local-db-check-'));
const results: Record<string, string> = {};
try {
  const migrations = await resetDatabase();
  results.migrationsReplayed = `pass (${migrations.length})`;
  await seedPrePivotData();
  const before = await retiredCounts();
  // Upgrade the real old filesystem shape as well as the six-migration database.
  const legacyRoot = join(hermesHome, 'profiles', PROFILE_A);
  await mkdir(join(legacyRoot, 'memories'), { recursive: true });
  await writeFile(join(legacyRoot, '.apt-claw.json'), JSON.stringify({ runtimeHash: 'a'.repeat(64) }));
  await writeFile(join(legacyRoot, 'SOUL.md'), 'A soul: be concise');
  await writeFile(join(legacyRoot, 'memories', 'USER.md'), 'A user cache');
  await writeFile(join(legacyRoot, 'memories', 'MEMORY.md'), 'A recovered before pivot');
  const legacySkill = join(legacyRoot, 'apt-shared-skills', 'commerce');
  await mkdir(legacySkill, { recursive: true });
  await writeFile(join(legacySkill, 'SKILL.md'), '# retired', { mode: 0o400 });
  await chmod(legacySkill, 0o500);
  await chmod(join(legacyRoot, 'apt-shared-skills'), 0o500);

  const migrationRepository = PostgresMemoryRepository.create(databaseUrl, false);
  try {
    const artifacts = { soulText: '', hotUserText: '', hotMemoryText: '' };
    await assert.rejects(migrationRepository.reconcileRuntimeArtifacts(C, artifacts), /profile is missing/);
    await assert.rejects(migrationRepository.reconcileRuntimeArtifacts(A, { ...artifacts, hotMemoryText: 'x'.repeat(2201) }), /size limit/);
    assert.equal((await sql.query('select hot_memory_text from public.claw_user_profiles where user_id = $1', [A])).rows[0].hot_memory_text, 'A memory cache');
    results.failedReconciliationPreservesDatabase = 'pass';
  } finally {
    await migrationRepository.close();
  }

  let app = await build(hermesHome);
  try {
    const historyA = await app.inject({ method: 'GET', url: '/v1/chat', headers: { authorization: 'Bearer a' } });
    assert.equal(historyA.statusCode, 200);
    assert.equal(historyA.json().messages.length, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/chat', headers: { authorization: 'Bearer b' } })).json().messages.length, 0);
    results.historyPreservedAndScoped = 'pass';

    const clientMessageId = '77777777-7777-4777-8777-777777777777';
    const runA = await send(app, 'a', clientMessageId, 'What size am I?');
    const eventsA = await sse(app, 'a', runA);
    assert.equal(eventsA.at(-1)?.type, 'run.completed');
    assert.equal(eventsA.at(-1)?.run?.response?.content, 'hello world');
    const submittedA = submissions.at(-1)!;
    assert.equal(submittedA.instance.userId, A);
    assert.match(submittedA.options!.instructions!, /A-SECRET/);
    assert.doesNotMatch(submittedA.options!.instructions!, /B-SECRET|B soul|B memory/);
    assert.match(submittedA.options!.instructions!, /A soul: be concise/);
    assert.doesNotMatch(submittedA.options!.instructions!, /apt_commerce_hunt|browser_navigate|Cart|Wishlist/);
    assert.deepEqual(submittedA.options!.conversationHistory!.map((message) => message.role), ['user', 'assistant', 'user']);
    const profileRootA = join(hermesHome, 'profiles', PROFILE_A);
    assert.equal(await readFile(join(profileRootA, 'SOUL.md'), 'utf8'), 'A soul: be concise');
    assert.match(submittedA.options!.instructions!, /A recovered before pivot/);
    assert.equal((await sql.query('select hot_memory_text from public.claw_user_profiles where user_id = $1', [A])).rows[0].hot_memory_text, 'A recovered before pivot');
    assert.equal(JSON.parse(await readFile(join(profileRootA, '.apt-claw-memory-backup.json'), 'utf8')).hotMemoryText, 'A recovered before pivot');
    assert.ok(!(await readdir(profileRootA)).includes('.apt-claw.json'));
    assert.ok(!(await readdir(profileRootA)).includes('apt-shared-skills'));
    results.legacyFilesystemMemoryRecovered = 'pass';
    const runRow = (await sql.query('select claw_release_id, claw_mode, claw_release_checksum, status from public.agent_runs where id = $1', [runA])).rows[0];
    assert.deepEqual(runRow, { claw_release_id: null, claw_mode: null, claw_release_checksum: null, status: 'completed' });
    assert.notEqual((await sql.query('select runtime_hash from public.claw_user_profiles where user_id = $1', [A])).rows[0].runtime_hash, 'a'.repeat(64));
    results.ownerScopedTurnAndMaterialization = 'pass';

    const submissionsBefore = submissions.length;
    const duplicate = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer a' }, payload: { clientMessageId, content: 'What size am I?' } });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(submissions.length, submissionsBefore);
    results.idempotentSend = 'pass';

    for (const suffix of ['', '/events']) {
      assert.equal((await app.inject({ method: 'GET', url: `/v1/chat/runs/${runA}${suffix}`, headers: { authorization: 'Bearer b' } })).statusCode, 404);
    }
    assert.equal((await app.inject({ method: 'POST', url: `/v1/chat/runs/${runA}/stop`, headers: { authorization: 'Bearer b' } })).statusCode, 404);
    results.crossUserDenial = 'pass';

    const tokenA = aptBridgeToken(PROFILE_A, config.hermes.keySecret);
    let bridgeChecks = 0;
    duringSubmit = async () => {
      const remembered = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${tokenA}` },
        payload: { tool: 'apt_remember', arguments: { subject_kind: 'self', subject_label: null, category: 'preference', fact: 'A-LEARNED prefers white leather', confidence: 0.8 } } });
      assert.equal(remembered.statusCode, 200, remembered.body);
      const searched = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${tokenA}` },
        payload: { tool: 'apt_search_knowledge', arguments: { query: 'US', limit: 10 } } });
      const facts = searched.json().facts as Array<{ fact: string }>;
      assert.ok(facts.some((fact) => fact.fact.includes('A-SECRET')));
      assert.ok(!facts.some((fact) => fact.fact.includes('B-SECRET')));
      assert.equal((await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${tokenA}` }, payload: { tool: 'apt_commerce_hunt', arguments: {} } })).statusCode, 400);
      const otherProfile = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${aptBridgeToken(PROFILE_B, config.hermes.keySecret)}` },
        payload: { tool: 'apt_search_knowledge', arguments: { query: 'US' } } });
      assert.equal(otherProfile.statusCode, 404);
      bridgeChecks += 1;
    };
    const secondRun = await send(app, 'a', '77777777-7777-4777-8777-777777777778', 'Remember I like leather');
    assert.equal((await sse(app, 'a', secondRun)).at(-1)?.type, 'run.completed');
    duringSubmit = null;
    assert.equal(bridgeChecks, 1);
    const learned = (await sql.query('select source_agent_run_id from public.claw_user_knowledge where user_id = $1 and fact like $2', [A, 'A-LEARNED%'])).rows[0];
    assert.equal(learned.source_agent_run_id, secondRun);
    results.bridgeToolsBoundToOwner = 'pass';

    await writeFile(join(profileRootA, 'memories', 'MEMORY.md'), 'A memory cache + learned from Hermes');
    const thirdRun = await send(app, 'a', '77777777-7777-4777-8777-777777777779', 'Do I prefer leather?');
    assert.equal((await sse(app, 'a', thirdRun)).at(-1)?.type, 'run.completed');
    const reconciled = (await sql.query('select hot_memory_text, revision from public.claw_user_profiles where user_id = $1', [A])).rows[0];
    assert.equal(reconciled.hot_memory_text, 'A memory cache + learned from Hermes');
    assert.equal(Number(reconciled.revision), 5);
    assert.match(submissions.at(-1)!.options!.instructions!, /A-LEARNED prefers white leather/);
    assert.match(submissions.at(-1)!.options!.instructions!, /learned from Hermes/);
    const actions = (await sql.query('select action from public.claw_learning_events where user_id = $1 order by created_at', [A])).rows.map((row) => row.action);
    assert.deepEqual(actions, ['reconcile', 'add', 'reconcile']);
    results.memoryReconciledAndSurvives = 'pass';

    const runB = await send(app, 'b', '88888888-8888-4888-8888-888888888888', 'Hi');
    assert.equal((await sse(app, 'b', runB)).at(-1)?.type, 'run.completed');
    const submittedB = submissions.at(-1)!;
    assert.match(submittedB.options!.instructions!, /B-SECRET|B soul/);
    assert.doesNotMatch(submittedB.options!.instructions!, /A-SECRET|A-LEARNED|A soul|learned from Hermes|white sneakers/);
    assert.equal(submittedB.options!.conversationHistory!.length, 1);
    results.twoUserIsolation = 'pass';

    slow = true;
    const slowRun = await send(app, 'b', '88888888-8888-4888-8888-888888888889', 'Long');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await app.inject({ method: 'POST', url: `/v1/chat/runs/${slowRun}/stop`, headers: { authorization: 'Bearer b' } })).statusCode, 202);
    assert.equal((await sse(app, 'b', slowRun)).at(-1)?.type, 'run.cancelled');
    assert.ok(stops.length >= 1);
    slow = false;
    results.stop = 'pass';

    await sql.query(`insert into auth.users(id, email) values ($1, 'c@example.com')`, [C]);
    await sql.query(`insert into public.agent_instances(user_id, hermes_profile_name, hermes_session_id) values ($1, 'apt-cccccccccccccccccccc', '99999999-9999-4999-8999-999999999990')`, [C]);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/chat', headers: { authorization: 'Bearer c' } })).statusCode, 403);
    results.thirdUserDenied = 'pass';
    // Independently exercise a newly configured founder's first turn.
    config.pilotUserIds[1] = C;
    const runC = await send(app, 'c', '99999999-9999-4999-8999-999999999991', 'First ever');
    assert.equal((await sse(app, 'c', runC)).at(-1)?.type, 'run.completed');
    assert.equal((await sql.query('select count(*) from public.claw_user_profiles where user_id = $1', [C])).rows[0].count, '1');
    // Let the post-run reconciliation finish before the pool closes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    results.freshUserFirstTurn = 'pass';
    config.pilotUserIds[1] = B;
  } finally {
    await app.close();
  }

  const orphan = await sql.query(`with req as (
      insert into public.messages(user_id, role, content, status, client_message_id, completed_at)
      values ($1, 'user', 'orphan', 'completed', gen_random_uuid(), now()) returning id
    ), res as (
      insert into public.messages(user_id, role, content, status, reply_to_message_id)
      select $1, 'assistant', '', 'streaming', id from req returning id
    )
    insert into public.agent_runs(user_id, request_message_id, response_message_id, status, hermes_run_id, started_at)
    select $1, req.id, res.id, 'running', 'hermes-orphan', now() from req, res returning id`, [A]);
  const stopsBefore = stops.length;
  app = await build(hermesHome);
  await app.close();
  const recovered = (await sql.query('select status, error_code from public.agent_runs where id = $1', [orphan.rows[0].id])).rows[0];
  assert.deepEqual(recovered, { status: 'failed', error_code: 'SERVER_RESTARTED' });
  assert.ok(stops.includes('hermes-orphan') && stops.length === stopsBefore + 1);
  results.restartRecovery = 'pass';

  assert.deepEqual(await retiredCounts(), before);
  results.retiredDataPreserved = 'pass';
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
} finally {
  await sql.end();
  await rm(hermesHome, { recursive: true, force: true });
}
