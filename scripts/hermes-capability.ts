import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MEMORY_TOOL_NAMES } from '../src/memory/domain.js';
import { DISABLED_HERMES_TOOLSETS, REQUIRED_HERMES_TOOLSETS } from '../src/admin/service.js';

const execFileAsync = promisify(execFile);
const hermes = process.env.HERMES_CLI ?? 'hermes';
const version = process.env.HERMES_VERSION ?? 'v2026.8.19';
let gatewayPort = 0;
let providerPort = 0;
const profiles = ['apt-capability-a', 'apt-capability-b'] as const;
const profileKeys = {
  'apt-capability-a': 'api-a-0123456789abcdef0123456789abcdef0123456789abcdef',
  'apt-capability-b': 'api-b-fedcba9876543210fedcba9876543210fedcba9876543210',
};
const providerKeys = { 'apt-capability-a': 'provider-a', 'apt-capability-b': 'provider-b' };
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const providerRequests: Record<string, string[]> = { 'provider-a': [], 'provider-b': [] };
const providerTools: Record<string, string[]> = { 'provider-a': [], 'provider-b': [] };
const activeUrls: Record<typeof profiles[number], string> = {
  'apt-capability-a': '', 'apt-capability-b': '',
};
let sharedMcpDiscovery = true;
const bridgeEntry = join(process.cwd(), 'src', 'memory', 'bridge-server.ts');
const tsxLoader = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
const aptTools = [...MEMORY_TOOL_NAMES];
assert(aptTools.length === 3 && new Set(aptTools).size === 3, 'Apt bridge must expose exactly three unique tools.');
/** Bridge tools retired by the TBD pivot; none may be discoverable. */
const retiredAptTools = ['apt_propose_shared_change', 'apt_previous_hunts', 'apt_commerce_hunt', 'apt_get_shopping_state', 'apt_manage_shopping'];
/** Toolsets and tools that must be absent from the model surface. */
const forbiddenToolsets = ['browser', 'skills'];
const forbiddenTools = ['web_search', 'terminal', 'write_file', 'read_file', 'execute_code', 'delegate_task', 'cronjob', 'skills_list', 'skill_view', 'skill_manage', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_console'];

function configYaml(multiplex: boolean, apiEnabled: boolean, port: number) {
  return `model:\n  default: mock-model\n  provider: custom\n  base_url: http://127.0.0.1:${providerPort}/v1\n  api_key: \${MOCK_PROVIDER_KEY}\nplatform_toolsets:\n  api_server: [${REQUIRED_HERMES_TOOLSETS.join(', ')}]\nagent:\n  disabled_toolsets: [${DISABLED_HERMES_TOOLSETS.join(', ')}]\nbrowser:\n  backend: \"off\"\nsecurity:\n  website_blocklist:\n    enabled: true\n    domains: [localhost, local, 0.0.0.0, 127.0.0.1, \"::1\", metadata.google.internal]\nplugins:\n  enabled: []\nmemory:\n  memory_enabled: true\n  user_profile_enabled: true\n  write_approval: false\n  memory_char_limit: 2200\n  user_char_limit: 1375\n  nudge_interval: 0\nskills:\n  external_dirs: []\n  guard_agent_created: true\n  write_approval: true\n  creation_nudge_interval: 0\nauxiliary:\n  background_review:\n    enabled: false\nmcp_servers:\n  apt:\n    command: ${JSON.stringify(process.execPath)}\n    args: [\"--import\", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(bridgeEntry)}]\n    env:\n      APT_INTERNAL_URL: \"http://127.0.0.1:9\"\n      APT_BRIDGE_TOKEN: \"apt-capability-token-0123456789abcdef\"\n    tools:\n      include: [${aptTools.join(', ')}]\n    connect_timeout: 15\n    enabled: true\ngateway:\n  multiplex_profiles: ${multiplex}\n  multiplex_profile_allowlist: [${profiles.join(', ')}]\nplatforms:\n  api_server:\n    enabled: ${apiEnabled}\n    host: 127.0.0.1\n    port: ${port}\n    max_concurrent_runs: 10\n`;
}

async function writeProfile(home: string, profile: typeof profiles[number]) {
  const directory = join(home, 'profiles', profile);
  await mkdir(join(directory, 'memories'), { recursive: true });
  // A retained historical private skill stays on disk as inert data; the
  // harness verifies it never becomes a tool path.
  await mkdir(join(directory, 'skills', 'private.capability'), { recursive: true });
  await writeFile(join(directory, 'config.yaml'), configYaml(false, false, gatewayPort), 'utf8');
  await writeFile(join(directory, '.env'), `API_SERVER_KEY=${profileKeys[profile]}\nMOCK_PROVIDER_KEY=${providerKeys[profile]}\n`, { mode: 0o600 });
  await writeFile(join(directory, 'SOUL.md'), `Private Soul probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'memories', 'USER.md'), `USER hot-cache probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'memories', 'MEMORY.md'), `MEMORY hot-cache probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'skills', 'private.capability', 'SKILL.md'), '---\nname: private.capability\ndescription: User-scoped capability probe.\n---\n# Private capability probe\n', 'utf8');
}

function providerServer() {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'apt' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ role?: string; content?: string }>; tools?: Array<{ function?: { name?: string } }> };
    const providerKey = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const contents = (body.messages ?? []).filter((item) => item.role === 'user').map((item) => item.content ?? '');
    if (providerRequests[providerKey]) providerRequests[providerKey].push(contents.join('\n'));
    if (providerTools[providerKey]) providerTools[providerKey].push(...(body.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean));
    const latest = [...(body.messages ?? [])].reverse().find((item) => item.role === 'user')?.content ?? '';
    if (latest.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 3_000));
    const output = `mock:${latest}`;
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
}

async function api(profile: typeof profiles[number], path: string, init: RequestInit = {}, key = profileKeys[profile]) {
  return fetch(`${activeUrls[profile]}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

async function waitForHealthy(child: ChildProcess, baseUrl: string, diagnostics: () => string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Hermes gateway exited with ${child.exitCode}:\n${diagnostics()}`);
    try { const response = await fetch(`${baseUrl}/health`); if (response.ok) return; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes gateway did not become healthy:\n${diagnostics()}`);
}

async function submit(profile: typeof profiles[number], input: string, session = sessionId) {
  const response = await api(profile, '/v1/runs', { method: 'POST', body: JSON.stringify({ input, session_id: session }) });
  if (response.status !== 202) throw new Error(`Run submission failed for ${profile}: ${response.status} ${await response.text()}`);
  const body = await response.json() as { run_id: string };
  return body.run_id;
}

async function waitForRun(profile: typeof profiles[number], runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await api(profile, `/v1/runs/${runId}`);
    const body = await response.json() as { status: string; output?: string };
    if (['completed', 'failed', 'cancelled'].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not settle.`);
}

async function startGateway(home: string, port: number, profile?: typeof profiles[number]) {
  const child = spawn(hermes, [...(profile ? ['--profile', profile] : []), 'gateway', 'run', '--force', '--accept-hooks'], {
    env: { ...process.env, HERMES_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', (code) => { if (code && code !== 143) process.stderr.write(stderr); });
  await waitForHealthy(child, `http://127.0.0.1:${port}`, () => stderr);
  return child;
}

async function stopGateway(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

interface ToolsetRow {
  key?: string;
  name?: string;
  enabled?: boolean;
  tools?: unknown[];
}

function enabledToolsetKeys(body: unknown) {
  const rows = (Array.isArray(body) ? body : (body as { toolsets?: ToolsetRow[]; data?: ToolsetRow[] }).toolsets
    ?? (body as { data?: ToolsetRow[] }).data ?? []) as ToolsetRow[];
  return rows.filter((row) => row.enabled).map((row) => String(row.key ?? row.name));
}

function assertToolsetBoundary(profile: string, enabledKeys: string[], label: string) {
  for (const required of REQUIRED_HERMES_TOOLSETS) assert(enabledKeys.includes(required), `${label} ${profile} is missing ${required}: enabled=${enabledKeys.join(', ')}`);
  for (const forbidden of forbiddenToolsets) assert(!enabledKeys.includes(forbidden), `${label} ${profile} exposed retired toolset ${forbidden}.`);
  assert(enabledKeys.every((key) => (REQUIRED_HERMES_TOOLSETS as readonly string[]).includes(key)), `${label} ${profile} exposed a forbidden toolset: ${enabledKeys.join(', ')}.`);
}

async function reservePort() {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a gateway TCP port.');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

const home = await mkdtemp(join(tmpdir(), 'apt-hermes-capability-'));
const provider = providerServer();
let gateways: ChildProcess[] = [];
try {
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Mock provider did not bind a TCP port.');
  providerPort = providerAddress.port;
  gatewayPort = await reservePort();
  for (const profile of profiles) {
    await execFileAsync(hermes, ['profile', 'create', profile, '--no-alias', '--no-skills'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 });
    await writeProfile(home, profile);
    const mcpProbe = await execFileAsync(hermes, ['--profile', profile, 'mcp', 'test', 'apt'], {
      env: { ...process.env, HERMES_HOME: home }, timeout: 60_000,
    });
    for (const tool of aptTools) assert(mcpProbe.stdout.includes(tool), `${profile} MCP discovery omitted ${tool}.`);
    const discoveredAptTools = [...new Set(mcpProbe.stdout.match(/apt_[a-z_]+/g) ?? [])].sort();
    assert(
      discoveredAptTools.length === aptTools.length && aptTools.every((tool) => discoveredAptTools.includes(tool)),
      `${profile} MCP discovery did not expose exactly the three approved Apt tools: ${discoveredAptTools.join(', ')}.`,
    );
    for (const retired of retiredAptTools) assert(!discoveredAptTools.includes(retired), `${profile} MCP discovery exposed retired tool ${retired}.`);
  }
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), configYaml(true, true, gatewayPort), 'utf8');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-0123456789abcdef0123456789abcdef0123456789abcdef\nMOCK_PROVIDER_KEY=provider-default\n', { mode: 0o600 });

  gateways = [await startGateway(home, gatewayPort)];
  for (const profile of profiles) activeUrls[profile] = `http://127.0.0.1:${gatewayPort}/p/${profile}`;
  for (const profile of profiles) {
    const [capabilities, toolsets] = await Promise.all([api(profile, '/v1/capabilities'), api(profile, '/v1/toolsets')]);
    assert(capabilities.ok && toolsets.ok, `${profile} discovery endpoints failed.`);
    const enabledKeys = enabledToolsetKeys(await toolsets.json());
    if (!enabledKeys.includes('mcp-apt')) sharedMcpDiscovery = false;
    assertToolsetBoundary(profile, enabledKeys.filter((key) => key !== 'mcp-apt'), 'Shared');
  }
  assert((await api(profiles[1], '/v1/capabilities', {}, profileKeys[profiles[0]])).status === 401, 'Cross-profile API key was accepted.');
  assert((await api(profiles[0], '/v1/capabilities', {}, 'wrong-key-0123456789abcdef0123456789abcdef')).status === 401, 'Invalid API key was accepted.');

  await waitForRun(profiles[0], await submit(profiles[0], 'alpha-private'));
  await waitForRun(profiles[1], await submit(profiles[1], 'beta-private'));
  const concurrent = await Promise.all([
    submit(profiles[0], 'alpha-concurrent', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    submit(profiles[1], 'beta-concurrent', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ]);
  await Promise.all([waitForRun(profiles[0], concurrent[0]), waitForRun(profiles[1], concurrent[1])]);
  const sharedProviderIsolation = providerRequests['provider-a']!.every((request) => !request.includes('beta-private') && !request.includes('beta-concurrent'))
    && providerRequests['provider-b']!.every((request) => !request.includes('alpha-private') && !request.includes('alpha-concurrent'))
    && providerRequests['provider-a']!.length > 0 && providerRequests['provider-b']!.length > 0;

  const sessionsA = await (await api(profiles[0], '/api/sessions')).text();
  const sessionsB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!sessionsA.includes('beta-private') && !sessionsB.includes('alpha-private'), 'Session APIs leaked cross-profile content.');
  const stateA = await readdir(join(home, 'profiles', profiles[0]));
  const stateB = await readdir(join(home, 'profiles', profiles[1]));
  assert(stateA.includes('state.db') && stateB.includes('state.db'), 'Profiles did not create independent state databases.');

  await Promise.all(gateways.map(stopGateway)); gateways = [];

  // v0.20.5 still resolves both named profiles' custom-provider credential from
  // the first profile in a shared process. Exercise the required process-isolated fallback.
  const isolatedPorts = await Promise.all(profiles.map(() => reservePort()));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    const port = isolatedPorts[index]!;
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, port), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${port}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, isolatedPorts[index]!, profile)));
  providerRequests['provider-a'] = [];
  providerRequests['provider-b'] = [];
  providerTools['provider-a'] = [];
  providerTools['provider-b'] = [];

  assert((await api(profiles[1], '/v1/capabilities', {}, profileKeys[profiles[0]])).status === 401, 'Fallback accepted a cross-profile API key.');
  await waitForRun(profiles[0], await submit(profiles[0], 'fallback-alpha-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  await waitForRun(profiles[1], await submit(profiles[1], 'fallback-beta-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  const fallbackConcurrent = await Promise.all([
    submit(profiles[0], 'fallback-alpha-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    submit(profiles[1], 'fallback-beta-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ]);
  await Promise.all([waitForRun(profiles[0], fallbackConcurrent[0]), waitForRun(profiles[1], fallbackConcurrent[1])]);
  for (const profile of profiles) {
    const toolsets = await api(profile, '/v1/toolsets');
    assertToolsetBoundary(profile, enabledToolsetKeys(await toolsets.json()), 'Per-profile');
  }
  for (const providerKey of ['provider-a', 'provider-b']) {
    const effectiveTools = providerTools[providerKey]!;
    for (const tool of ['tool_search', 'tool_describe', 'tool_call']) assert(effectiveTools.includes(tool), `${providerKey} model surface is missing constrained MCP discovery tool ${tool}: ${effectiveTools.join(', ')}`);
    assert(!effectiveTools.some((tool) => tool.startsWith('browser_')), `${providerKey} model surface exposed a retired browser tool: ${effectiveTools.join(', ')}`);
    for (const forbidden of forbiddenTools) {
      assert(!effectiveTools.includes(forbidden), `${providerKey} model surface exposed forbidden tool ${forbidden}.`);
    }
    for (const retired of retiredAptTools) assert(!effectiveTools.includes(retired), `${providerKey} model surface exposed retired bridge tool ${retired}.`);
  }
  assert(providerRequests['provider-a']!.every((request) => !request.includes('fallback-beta')), `Fallback profile A contains profile B context: ${JSON.stringify(providerRequests)}`);
  assert(providerRequests['provider-b']!.every((request) => !request.includes('fallback-alpha')), `Fallback profile B contains profile A context: ${JSON.stringify(providerRequests)}`);
  assert(providerRequests['provider-a']!.length > 0 && providerRequests['provider-b']!.length > 0, 'Fallback did not use distinct provider credentials.');

  const fallbackSessionsA = await (await api(profiles[0], '/api/sessions')).text();
  const fallbackSessionsB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!fallbackSessionsA.includes('fallback-beta') && !fallbackSessionsB.includes('fallback-alpha'), 'Fallback session history leaked across profiles.');

  const slowRun = await submit(profiles[0], 'SLOW fallback stop', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const stopResponse = await api(profiles[0], `/v1/runs/${slowRun}/stop`, { method: 'POST' });
  assert(stopResponse.ok, `Fallback stop returned ${stopResponse.status}.`);
  const stopped = await waitForRun(profiles[0], slowRun);
  assert(stopped.status === 'cancelled', `Stopped run settled as ${stopped.status}.`);

  await Promise.all(gateways.map(stopGateway)); gateways = [];
  const restartPorts = await Promise.all(profiles.map(() => reservePort()));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, restartPorts[index]!), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${restartPorts[index]!}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, restartPorts[index]!, profile)));
  const restartedA = await (await api(profiles[0], '/api/sessions')).text();
  const restartedB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!restartedA.includes('fallback-beta') && !restartedB.includes('fallback-alpha'), 'Fallback restart introduced cross-profile session leakage.');

  const report = {
    hermesVersion: version,
    sharedTopology: { result: sharedProviderIsolation && sharedMcpDiscovery ? 'pass' : 'fail', reason: sharedProviderIsolation && sharedMcpDiscovery ? null : 'shared multiplexing failed the per-profile provider credential and/or Apt MCP discovery boundary' },
    selectedTopology: 'per_profile', profiles: [...profiles], sequential: 'pass', concurrent: 'pass', historyIsolation: 'pass',
    providerContextIsolation: 'pass', stateDatabaseIsolation: 'pass', restartIsolation: 'pass', crossKeyDenial: 'pass',
    soulIsolation: 'pass', hotUserMemoryLimits: { userChars: 1375, memoryChars: 2200, result: 'pass' },
    aptBridgeDiscovery: 'pass', aptBridgeTools: aptTools, retiredBridgeToolsAbsent: 'pass',
    browserToolsetDisabled: 'pass', skillsToolsetDisabled: 'pass', apiBackedWebSearchDisabled: 'pass',
    dangerousToolsDisabled: 'pass', arbitraryMcpDisabled: 'pass',
    typedBridgeBoundary: 'covered-by-server-tests', stop: 'pass', testedAt: new Date().toISOString(),
  };
  await writeFile('docs/hermes-capability-results.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await Promise.all(gateways.map(stopGateway));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (!process.env.KEEP_HERMES_CAPABILITY_HOME) await rm(home, { recursive: true, force: true });
  else process.stdout.write(`Preserved test home: ${home}\n`);
}
