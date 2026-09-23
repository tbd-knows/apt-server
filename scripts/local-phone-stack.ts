import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { mobileApiUrl, profileUrlMap, requestedUserIds, upsertEnvironment } from '../src/local-stack.js';
import { PostgresChatRepository } from '../src/repository.js';
import { HermesCliProfileAdmin, ProvisioningService, SupabaseUserAdmin } from '../src/admin/service.js';

const execFileAsync = promisify(execFile);
const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mobileDirectory = resolve(serverDirectory, process.env.APT_MOBILE_DIR ?? '../apt-mobile');
const managed: ManagedProcess[] = [];
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
let requestedSignal: NodeJS.Signals | undefined;
let resolveStop!: (signal: NodeJS.Signals) => void;
const stopRequested = new Promise<NodeJS.Signals>((resolveSignal) => { resolveStop = resolveSignal; });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    if (!requestedSignal) {
      requestedSignal = signal;
      resolveStop(signal);
    }
    void stopAll();
  });
}
process.once('exit', () => {
  for (const process_ of [...managed].reverse()) terminateGroup(process_.child, 'SIGTERM');
});

interface ManagedProcess {
  label: string;
  child: ChildProcess;
  exited: Promise<{ label: string; code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
}

async function main() {
  assertMacDevelopmentEnvironment();
  await requireFile(resolve(serverDirectory, '.env'), 'Copy apt-server/.env.example to apt-server/.env and add the shared development secrets.');
  await requireFile(resolve(mobileDirectory, 'package.json'), 'Keep apt-server and apt-mobile beside each other, or set APT_MOBILE_DIR.');

  const hermesHome = localHermesHome();
  const hermesCli = await ensureHermesCli(process.env.HERMES_CLI ?? 'hermes', process.env.HERMES_VERSION ?? 'v2026.8.19');
  process.env.HERMES_HOME = hermesHome;
  process.env.HERMES_CLI = hermesCli;

  const config = loadConfig();
  if (config.hermes.topology !== 'per_profile') {
    throw new Error('The one-command stack requires HERMES_TOPOLOGY=per_profile.');
  }

  const selected = requestedUserIds(process.argv.slice(2), process.env.APT_LOCAL_USER_IDS);
  const userIds = selected.length ? selected : await readyUserIds(config.supabase.databaseUrl, config.supabase.databaseSsl);
  if (!userIds.length) {
    throw new Error('No ready beta users exist. Set APT_LOCAL_USER_IDS or pass one or more --user-id values.');
  }

  process.stdout.write(`\nPreparing ${userIds.length} beta profile${userIds.length === 1 ? '' : 's'}...\n`);
  const repository = PostgresChatRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
  const provisioning = new ProvisioningService(
    repository,
    SupabaseUserAdmin.create(config.supabase.url, config.supabase.serviceRoleKey),
    new HermesCliProfileAdmin(config.hermes),
    config.hermes.keySecret,
  );
  const profiles = [];
  try {
    for (const userId of userIds) {
      const instance = await provisioning.provision(userId);
      profiles.push({ userId: instance.userId, profileName: instance.hermesProfileName });
      process.stdout.write(`  ready ${instance.userId} -> ${instance.hermesProfileName}\n`);
    }
  } finally {
    await repository.close();
  }

  const basePort = integerEnvironment('APT_LOCAL_HERMES_BASE_PORT', 8642);
  const routes = profileUrlMap(profiles, basePort);
  const a2aRoutes = profileUrlMap(profiles, integerEnvironment('APT_LOCAL_A2A_BASE_PORT', 9900));
  const metroPort = 8081;
  const requiredPorts = [...routes.map((route) => route.port), ...a2aRoutes.map(route => route.port), config.port, metroPort];
  if (new Set(requiredPorts).size !== requiredPorts.length) throw new Error('Hermes, Apt Server, and Metro ports must be distinct.');
  for (const port of requiredPorts) await requireAvailablePort(port);

  try {
    for (const route of routes) {
      const gateway = startProcess(
        `Hermes ${route.profileName}`,
        hermesCli,
        ['--profile', route.profileName, 'gateway', 'run', '--force', '--external-supervisor', '--accept-hooks'],
        serverDirectory,
        {
          ...process.env,
          HERMES_HOME: hermesHome,
          API_SERVER_ENABLED: 'true',
          API_SERVER_HOST: '127.0.0.1',
          API_SERVER_PORT: String(route.port),
          A2A_HOST: '127.0.0.1',
          A2A_PORT: String(a2aRoutes.find(peer => peer.profileName === route.profileName)!.port),
        },
      );
      await waitForHealth(route.url, gateway, 60_000);
      process.stdout.write(`  healthy ${route.profileName} on ${route.url}\n`);
    }

    const urlMap = Object.fromEntries(routes.map((route) => [route.profileName, route.url]));
    const server = startProcess(
      'Apt Server',
      process.execPath,
      ['--env-file-if-exists=.env', '--import', 'tsx', 'src/server.ts'],
      serverDirectory,
      {
        ...process.env,
        HOST: '0.0.0.0',
        HERMES_HOME: hermesHome,
        HERMES_CLI: hermesCli,
        HERMES_BASE_URL: routes[0]!.url,
        HERMES_PROFILE_URL_MAP: JSON.stringify(urlMap),
        HERMES_A2A_PROFILE_URL_MAP: JSON.stringify(Object.fromEntries(a2aRoutes.map(route => [route.profileName, route.url]))),
      },
    );
    await waitForHealth(`http://127.0.0.1:${config.port}`, server, 30_000, true);

    const apiUrl = mobileApiUrl(networkInterfaces(), config.port, process.env.APT_MOBILE_API_URL, process.env.APT_LOCAL_LAN_IP);
    if (process.env.APT_MOBILE_API_URL !== undefined) {
      try {
        const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
        const body = await health.json() as { status?: string };
        if (!health.ok || body.status !== 'ok') throw new Error('Unhealthy API');
      } catch {
        throw new Error('APT_MOBILE_API_URL is unreachable or unhealthy. Start the API tunnel/overlay and verify /health; Metro does not expose Fastify.');
      }
    }
    await writeMobileEnvironment(apiUrl, config.supabase.url, config.supabase.publishableKey);
    process.stdout.write(`\nApt Server is healthy. The iPhone will use ${apiUrl}.\n`);
    process.stdout.write('Building, installing, launching, and starting Metro...\n\n');

    const mobile = startProcess(
      'apt-mobile',
      'npm',
      ['run', 'ios:phone'],
      mobileDirectory,
      { ...process.env, APT_METRO_MODE: process.env.APT_METRO_MODE ?? 'lan' },
    );

    const firstExit = Promise.race(managed.map((process_) => process_.exited));
    const outcome = await Promise.race([stopRequested, firstExit]);
    if (typeof outcome !== 'string') {
      if (outcome.error) throw outcome.error;
      if (outcome.label === 'apt-mobile' && outcome.code === 0) return;
      if (!shuttingDown) throw new Error(`${outcome.label} exited unexpectedly (${outcome.signal ?? outcome.code ?? 'unknown'}).`);
    }
    void mobile;
  } finally {
    await stopAll();
  }
}

function assertMacDevelopmentEnvironment() {
  if (process.platform !== 'darwin') throw new Error('The physical-iPhone stack must run on macOS.');
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22) process.stderr.write(`Warning: Node 22 LTS is the supported version; current runtime is ${process.version}.\n`);
}

function localHermesHome() {
  const configured = process.env.APT_LOCAL_HERMES_HOME
    ?? (process.env.HERMES_HOME === '/var/lib/hermes' ? '.local/hermes' : process.env.HERMES_HOME)
    ?? '.local/hermes';
  return isAbsolute(configured) ? configured : resolve(serverDirectory, configured);
}

async function ensureHermesCli(configured: string, version: string) {
  const explicit = configured !== 'hermes';
  const candidate = explicit
    ? (isAbsolute(configured) ? configured : resolve(serverDirectory, configured))
    : await executableOnPath('hermes');
  if (candidate) {
    try {
      await verifyHermesVersion(candidate, version);
      return candidate;
    } catch (error) {
      if (explicit) throw error;
      process.stdout.write(`The Hermes on PATH is not ${version}; using a pinned repo-local installation.\n`);
    }
  }
  if (explicit) throw new Error(`Configured HERMES_CLI does not exist or is not executable: ${configured}`);
  if (!/^v\d{4}\.\d+\.\d+$/.test(version)) throw new Error('HERMES_VERSION must be an exact release such as v2026.8.19.');

  const python = await executableOnPath('python3.12');
  if (!python) throw new Error('Python 3.12 is required to bootstrap Hermes. Install it with `brew install python@3.12`.');
  const environment = resolve(serverDirectory, '.local', `hermes-${version}`);
  const cli = resolve(environment, 'bin', 'hermes');
  const source = resolve(environment, 'source');
  await mkdir(dirname(environment), { recursive: true });
  if (await executable(cli)) {
    try {
      await verifyHermesVersion(cli, version);
      return cli;
    } catch { /* repair the managed installation below */ }
  }
  process.stdout.write(`Hermes is not installed; bootstrapping pinned ${version} in ${environment}...\n`);
  if (!await executable(cli)) await foreground(python, ['-m', 'venv', environment], serverDirectory);

  // Hermes releases intentionally reject wheel/sdist builds. Keep an exact,
  // shallow source checkout and install it in the supported editable mode.
  // Stage the clone separately so an interrupted download can be repaired by
  // simply rerunning the launcher.
  if (!await readable(resolve(source, '.git', 'HEAD'))) {
    const stagedSource = resolve(environment, `source-install-${process.pid}`);
    await rm(stagedSource, { recursive: true, force: true });
    try {
      await foreground('git', [
        'clone', '--depth', '1', '--branch', version, '--single-branch',
        'https://github.com/NousResearch/hermes-agent.git', stagedSource,
      ], serverDirectory);
      await rm(source, { recursive: true, force: true });
      await rename(stagedSource, source);
    } finally {
      await rm(stagedSource, { recursive: true, force: true });
    }
  }
  // The [mcp] extra installs the Python MCP SDK that Hermes needs to load the
  // Apt bridge; without it `hermes mcp test apt` fails during provisioning.
  await foreground(resolve(environment, 'bin', 'python'), [
    '-m', 'pip', 'install', '--disable-pip-version-check', '--editable', `${source}[mcp]`,
    'aiohttp>=3.9,<4',
  ], serverDirectory);
  await verifyHermesVersion(cli, version);
  return cli;
}

async function verifyHermesVersion(cli: string, expected: string) {
  const { stdout, stderr } = await execFileAsync(cli, ['--version'], { timeout: 15_000 });
  const output = `${stdout}${stderr}`;
  if (!output.includes(expected.slice(1))) {
    throw new Error(`HERMES_CLI is not the pinned ${expected} release. Received: ${output.split('\n')[0] ?? 'unknown'}`);
  }
}

async function readyUserIds(databaseUrl: string, ssl: boolean) {
  const client = new pg.Client({ connectionString: databaseUrl, ssl: ssl ? { rejectUnauthorized: false } : false });
  await client.connect();
  try {
    const result = await client.query<{ user_id: string }>(
      `select user_id from public.agent_instances where status = 'ready' order by user_id`,
    );
    return result.rows.map((row) => row.user_id);
  } finally {
    await client.end();
  }
}

async function writeMobileEnvironment(apiUrl: string, supabaseUrl: string, publishableKey: string) {
  const path = resolve(mobileDirectory, '.env.local');
  let existing = '';
  try { existing = await readFile(path, 'utf8'); } catch { /* first local run */ }
  const next = upsertEnvironment(existing, {
    EXPO_PUBLIC_APT_API_URL: apiUrl,
    EXPO_PUBLIC_SUPABASE_URL: supabaseUrl,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: publishableKey,
  });
  await writeFile(path, next, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function startProcess(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  process.stdout.write(`Starting ${label}...\n`);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: 'inherit' });
  const exited = new Promise<Awaited<ManagedProcess['exited']>>((resolveExit) => {
    child.once('error', (error) => resolveExit({ label, code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolveExit({ label, code, signal }));
  });
  const process_ = { label, child, exited };
  managed.push(process_);
  return process_;
}

async function waitForHealth(url: string, process_: ManagedProcess, timeout: number, requireDependencies = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (requestedSignal) throw new Error(`Local stack stopped by ${requestedSignal}.`);
    if (process_.child.exitCode !== null || process_.child.signalCode !== null) {
      throw new Error(`${process_.label} exited before becoming healthy.`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        if (!requireDependencies) return;
        const body = await response.json() as { status?: string };
        if (body.status === 'ok') return;
      }
    } catch { /* keep waiting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`${process_.label} did not become healthy within ${timeout / 1_000} seconds.`);
}

async function requireAvailablePort(port: number) {
  const available = await new Promise<boolean>((resolveAvailable) => {
    const server = createServer();
    server.once('error', () => resolveAvailable(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolveAvailable(true)));
  });
  if (!available) throw new Error(`Port ${port} is already in use. Stop the previous local stack and retry.`);
}

function integerEnvironment(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return value;
}

function stopAll() {
  shutdownPromise ??= performStopAll();
  return shutdownPromise;
}

async function performStopAll() {
  shuttingDown = true;
  if (managed.length) process.stdout.write('\nStopping local Apt stack...\n');
  for (const process_ of [...managed].reverse()) terminateGroup(process_.child, 'SIGTERM');
  await Promise.race([
    Promise.allSettled(managed.map((process_) => process_.exited)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  for (const process_ of [...managed].reverse()) {
    if (process_.child.exitCode === null && process_.child.signalCode === null) terminateGroup(process_.child, 'SIGKILL');
  }
}

function terminateGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch { /* already stopped */ }
}

async function executableOnPath(command: string) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/env', ['which', command], { timeout: 5_000 });
    const path = stdout.trim();
    return path && await executable(path) ? path : undefined;
  } catch { return undefined; }
}

async function executable(path: string) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

async function readable(path: string) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

async function requireFile(path: string, guidance: string) {
  try { await access(path, constants.R_OK); } catch { throw new Error(`${path} is missing. ${guidance}`); }
}

async function foreground(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code !== 0) throw new Error(`${command} exited with ${code ?? 'a signal'}.`);
}

await main().catch(async (error) => {
  await stopAll();
  if (requestedSignal) return;
  process.stderr.write(`\nLocal stack failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
