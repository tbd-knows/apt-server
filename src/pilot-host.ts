import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { profileIdentity } from './admin/service.js';
import { profileUrlMap } from './local-stack.js';
import { hermesApiKey } from './agent-runtime.js';
import { aptBridgeToken } from './memory/bridge-auth.js';
import { a2aBridgeToken, a2aPeerToken } from './commerce/a2a-auth.js';

export const HOST_HOME = '/var/lib/tbd/hermes';
export const HOST_APP = '/opt/tbd/app';
export const HOST_NODE = '/opt/tbd/node/bin/node';
export const HOST_CLI = '/opt/tbd/hermes/bin/hermes';

/** Fixed paths/ports keep this a two-founder host, without an orchestration layer. */
export function pilotHostPlan(config: AppConfig, publicUrl: string) {
  if (config.nodeEnv !== 'production' || config.host !== '127.0.0.1' || config.port !== 8787
    || config.hermes.home !== HOST_HOME || config.hermes.cli !== HOST_CLI
    || config.hermes.internalUrl !== 'http://127.0.0.1:8787' || config.hermes.topology !== 'per_profile'
    || config.internalPeerIps.length) throw new Error('Use the fixed production host settings in docs/persistent-pilot-host.md.');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)) {
    throw new Error('APT_PUBLIC_URL must be a public HTTPS DNS origin without credentials, port, path or query.');
  }
  const profiles = config.pilotUserIds.map(userId => ({ userId, ...profileIdentity(userId, config.hermes.keySecret) }));
  const routes = profileUrlMap(profiles, 8642).map((route, index) => ({
    ...route, sessionId: profiles.find(p => p.profileName === route.profileName)!.sessionId,
    instance: `founder${index + 1}`, a2aUrl: `http://127.0.0.1:${9900 + index}`, a2aPort: 9900 + index,
  }));
  return { origin: url.origin, routes };
}
export type PilotHostPlan = ReturnType<typeof pilotHostPlan>;

export function pilotHostFiles(plan: PilotHostPlan): Record<string, string> {
  // Node reads routing.env, systemd reads the small Hermes files. Neither contains credentials.
  const files: Record<string, string> = {
    'routing.env': `HERMES_BASE_URL=${plan.routes[0]!.url}\nHERMES_PROFILE_URL_MAP=${JSON.stringify(Object.fromEntries(plan.routes.map(r => [r.profileName, r.url])))}\nHERMES_A2A_PROFILE_URL_MAP=${JSON.stringify(Object.fromEntries(plan.routes.map(r => [r.profileName, r.a2aUrl])))}\n`,
    'Caddyfile': `${plan.origin} {
  @public path /health /v1/* /webhooks/stripe /commerce/return /commerce/connections/callback /commerce/connections/client.json
  handle @public {
    reverse_proxy 127.0.0.1:8787 {
      flush_interval -1
    }
  }
  handle {
    respond 404
  }
}
`,
  };
  for (const route of plan.routes) files[`${route.instance}.env`] = [
    `HERMES_HOME=${HOST_HOME}`, `HERMES_PROFILE=${route.profileName}`, 'API_SERVER_ENABLED=true',
    'API_SERVER_HOST=127.0.0.1', `API_SERVER_PORT=${route.port}`, 'A2A_HOST=127.0.0.1', `A2A_PORT=${route.a2aPort}`, '',
  ].join('\n');
  return files;
}

export function assertReadyHostProfiles(plan: PilotHostPlan, rows: Array<{
  user_id: string; hermes_profile_name: string; hermes_session_id: string; status: string;
}>) {
  for (const route of plan.routes) {
    const row = rows.find(row => row.user_id === route.userId);
    if (!row || row.status !== 'ready' || row.hermes_profile_name !== route.profileName || row.hermes_session_id !== route.sessionId) {
      throw new Error(`${route.instance} must be provisioned and ready with the current root secret before enabling the host.`);
    }
  }
}

/** Never print profile env values or include their contents in an error. */
export function assertHostProfileSecrets(plan: PilotHostPlan, profileName: string, source: string, config: AppConfig) {
  const peer = plan.routes.find(r => r.profileName !== profileName)!;
  const env = parseEnv(source);
  const expected: Record<string, string> = {
    API_SERVER_KEY: hermesApiKey(profileName, config.hermes.keySecret),
    APT_INTERNAL_URL: config.hermes.internalUrl,
    APT_BRIDGE_TOKEN: aptBridgeToken(profileName, config.hermes.keySecret),
    APT_A2A_BRIDGE_TOKEN: a2aBridgeToken(profileName, config.hermes.keySecret),
    A2A_PEER_TOKENS: `${peer.profileName}:${a2aPeerToken(peer.profileName, profileName, config.hermes.keySecret)}`,
    A2A_TRUSTED_PEERS: peer.profileName, A2A_AGENT_NAME: profileName,
    [config.hermes.providerKeyEnv]: config.hermes.providerApiKey,
  };
  if (Object.entries(expected).some(([key, value]) => env[key] !== value) || env.A2A_BEARER_TOKEN || env.A2A_ALLOW_ALL_USERS) {
    throw new Error('Stored profile credentials do not match this deployment; reprovision with the stable host paths.');
  }
}

/** Probe each runtime and incoming peer credential, without running a model turn. */
export async function checkHostEndpoints(plan: PilotHostPlan, secret: string, request: typeof fetch = fetch) {
  for (const route of plan.routes) {
    const peer = plan.routes.find(r => r.profileName !== route.profileName)!;
    for (const [url, token, kind] of [
      [`${route.url}/v1/capabilities`, hermesApiKey(route.profileName, secret), 'runtime'],
      [`${route.a2aUrl}/.well-known/agent-card.json`, a2aPeerToken(peer.profileName, route.profileName, secret), 'a2a'],
    ] as const) {
      let response: Response;
      try { response = await request(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5_000) }); }
      catch { throw new Error(`${route.instance} ${kind} is unreachable.`); }
      if (!response.ok) throw new Error(`${route.instance} ${kind} authentication/readiness failed (${response.status}).`);
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || (kind === 'a2a' && (body as { name?: unknown }).name !== route.profileName)) {
        throw new Error(`${route.instance} ${kind} returned an unexpected identity or response.`);
      }
    }
    // Native agent cards are public even on authenticated listeners. A missing
    // task read proves bearer authentication without creating an A2A/model task.
    const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tasks/get', params: { id: randomUUID() } });
    const probe = async (authorized: boolean) => {
      try { return await request(`${route.a2aUrl}/`, { method: 'POST', body,
        headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${a2aPeerToken(peer.profileName, route.profileName, secret)}` } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(5_000) }); }
      catch { throw new Error(`${route.instance} a2a authentication probe is unreachable.`); }
    };
    if ((await probe(false)).status !== 401) throw new Error(`${route.instance} a2a accepts unauthenticated task requests.`);
    const authenticated = await probe(true);
    if (!authenticated.ok || (await authenticated.json() as { error?: { code?: number } }).error?.code !== -32001) {
      throw new Error(`${route.instance} a2a peer credential failed the read-only task probe.`);
    }
  }
}
