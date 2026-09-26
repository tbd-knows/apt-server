import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { assertHostProfileSecrets, assertReadyHostProfiles, checkHostEndpoints, HOST_APP, HOST_NODE, pilotHostFiles, pilotHostPlan } from '../pilot-host.js';

const [command, output, ...extra] = process.argv.slice(2);
if (extra.length || !['render', 'check', 'check-running'].includes(command ?? '') || (command === 'render' ? !output : output)) {
  throw new Error('Usage: pilot-host render <new-output-directory> | check | check-running');
}
const config = loadConfig();
const plan = pilotHostPlan(config, process.env.APT_PUBLIC_URL ?? '');
if (command === 'render') {
  const directory = resolve(output!);
  // Refuse to overwrite an installed or partially generated configuration.
  await mkdir(directory, { mode: 0o700 });
  for (const [name, content] of Object.entries(pilotHostFiles(plan))) {
    await writeFile(resolve(directory, name), content, { flag: 'wx', mode: 0o600 });
  }
  await chmod(directory, 0o700);
  process.stdout.write('Host configuration written. No secrets copied, services started, or remote data changed.\n');
} else {
  if (Number(process.versions.node.split('.')[0]) !== 22 || process.execPath !== HOST_NODE) {
    throw new Error(`Run this check with Node 22 at ${HOST_NODE}, also used by the provisioned MCP bridge.`);
  }
  const client = new pg.Client({ connectionString: config.supabase.databaseUrl,
    ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000 });
  try {
    await client.connect();
    const rows = await client.query(`select user_id,hermes_profile_name,hermes_session_id,status
      from public.agent_instances where user_id = any($1::uuid[])`, [config.pilotUserIds]);
    assertReadyHostProfiles(plan, rows.rows);
    // Read-only existence check for the latest commerce execution tables.
    await client.query('select 1 from public.pilot_service_actions limit 0');
  } finally { await client.end(); }
  for (const route of plan.routes) {
    const directory = `${config.hermes.home}/profiles/${route.profileName}`;
    const path = `${directory}/.env`;
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) throw new Error('Profile secrets must be private (0600).');
    assertHostProfileSecrets(plan, route.profileName, await readFile(path, 'utf8'), config);
    await access(`${directory}/config.yaml`, constants.R_OK);
    await access(`${directory}/plugins/tbd-commerce-a2a/__init__.py`, constants.R_OK);
    await access(directory, constants.W_OK);
  }
  await access(`${HOST_APP}/dist/memory/bridge-server.js`, constants.R_OK);
  const { stdout } = await promisify(execFile)(config.hermes.cli, ['--version'], { timeout: 15_000 });
  if (!stdout.includes(config.hermes.version.replace(/^v/, ''))) throw new Error('Hermes version does not match the pinned release.');
  for (const [name, content] of Object.entries(pilotHostFiles(plan))) {
    if (name === 'Caddyfile') continue;
    if (await readFile(`/etc/tbd/${name}`, 'utf8') !== content) throw new Error(`${name} differs from the current two-founder routing plan.`);
  }
  if (command === 'check-running') {
    await checkHostEndpoints(plan, config.hermes.keySecret);
    const response = await fetch('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok || (await response.json() as { status?: string }).status !== 'ok') throw new Error('Server or database health failed.');
  }
  process.stdout.write(`Host ${command} passed. No model turn, provider purchase, or payment was requested.\n`);
}
