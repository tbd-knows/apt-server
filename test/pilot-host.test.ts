import { parseEnv } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { HermesAgentRuntime } from '../src/agent-runtime.js';
import { assertReadyHostProfiles, checkHostEndpoints, HOST_CLI, HOST_HOME, pilotHostFiles, pilotHostPlan } from '../src/pilot-host.js';

const env = {
  NODE_ENV: 'production', HERMES_HOME: HOST_HOME, HERMES_CLI: HOST_CLI,
  APT_PILOT_USER_IDS: '11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-tests',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests', SUPABASE_DATABASE_URL: 'postgresql://example',
  HERMES_KEY_SECRET: 'x'.repeat(32), HERMES_MODEL: 'test-model', HERMES_PROVIDER_API_KEY: 'test-provider-key',
};
const config = loadConfig(env);
const plan = pilotHostPlan(config, 'https://pilot.example.com');

describe('persistent two-founder host', () => {
  it('keeps each owner on the same ports across order changes and emits no provider/root secrets', () => {
    const reordered = loadConfig({ ...env, APT_PILOT_USER_IDS: env.APT_PILOT_USER_IDS.split(',').reverse().join(',') });
    expect(pilotHostPlan(reordered, plan.origin)).toEqual(plan);
    const files = pilotHostFiles(plan);
    const routing = parseEnv(files['routing.env']!);
    const deployed = loadConfig({ ...env, ...routing });
    expect(Object.values(deployed.hermes.profileUrls)).toEqual(['http://127.0.0.1:8642', 'http://127.0.0.1:8643']);
    expect(Object.values(deployed.hermes.a2aProfileUrls)).toEqual(['http://127.0.0.1:9900', 'http://127.0.0.1:9901']);
    for (const secret of [env.SUPABASE_SERVICE_ROLE_KEY, env.HERMES_KEY_SECRET, env.HERMES_PROVIDER_API_KEY]) {
      expect(Object.values(files).join('')).not.toContain(secret);
    }
    expect(parseEnv(files['founder2.env']!).API_SERVER_PORT).toBe('8643');
    expect(files.Caddyfile).toContain('/commerce/connections/callback');
    expect(files.Caddyfile).not.toContain('/internal');
  });
  it('rejects exposed internal listeners and unsafe proxy site input', () => {
    expect(() => pilotHostPlan(loadConfig({ ...env, HOST: '0.0.0.0' }), plan.origin)).toThrow('fixed production');
    for (const origin of ['http://pilot.example.com', 'https://user:secret@pilot.example.com', 'https://pilot.example.com/path', 'https://localhost', 'https://pilot.example.com:8443', 'https://pilot.example.com?x=1']) {
      expect(() => pilotHostPlan(config, origin)).toThrow();
    }
  });
  it('rejects a missing, disabled or differently bound second founder', () => {
    const rows = plan.routes.map(r => ({ user_id: r.userId, hermes_profile_name: r.profileName, hermes_session_id: r.sessionId, status: 'ready' }));
    expect(() => assertReadyHostProfiles(plan, rows)).not.toThrow();
    expect(() => assertReadyHostProfiles(plan, rows.slice(0, 1))).toThrow('founder2');
    for (const change of [{ status: 'disabled' }, { hermes_session_id: 'wrong' }, { hermes_profile_name: 'wrong' }]) {
      expect(() => assertReadyHostProfiles(plan, [rows[0]!, { ...rows[1]!, ...change }])).toThrow('founder2');
    }
  });
  it('checks authenticated discovery in both directions without model requests', async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const route = plan.routes.find(r => String(input).startsWith(r.url) || String(input).startsWith(r.a2aUrl))!;
      if (init?.method === 'POST') return (init.headers as Record<string, string>).Authorization
        ? Response.json({ error: { code: -32001 } }) : new Response('', { status: 401 });
      return Response.json(String(input).endsWith('agent-card.json') ? { name: route.profileName } : { capabilities: [] });
    });
    await checkHostEndpoints(plan, config.hermes.keySecret, request);
    expect(request).toHaveBeenCalledTimes(8);
    const tokens = request.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Authorization).filter(Boolean);
    expect(new Set(tokens).size).toBe(4);
    request.mockImplementation(async input => String(input).includes(':9901') ? new Response('', { status: 401 }) : Response.json({}));
    // The first A2A card is also checked for the correct profile identity.
    await expect(checkHostEndpoints(plan, config.hermes.keySecret, request)).rejects.toThrow('identity');
    request.mockImplementation(async (input, init) => {
      const route = plan.routes.find(r => String(input).startsWith(r.url) || String(input).startsWith(r.a2aUrl))!;
      if (init?.method === 'POST') return (init.headers as Record<string, string>).Authorization
        ? Response.json({ error: { code: -32001 } }) : new Response('', { status: 401 });
      return String(input).includes(':9901') ? new Response('', { status: 401 }) : Response.json({ name: route.profileName });
    });
    await expect(checkHostEndpoints(plan, config.hermes.keySecret, request)).rejects.toThrow('founder2 a2a');
    request.mockImplementation(async input => {
      const route = plan.routes.find(r => String(input).startsWith(r.url) || String(input).startsWith(r.a2aUrl))!;
      return Response.json({ name: route.profileName });
    });
    await expect(checkHostEndpoints(plan, config.hermes.keySecret, request)).rejects.toThrow('unauthenticated');
  });
  it('reports the whole runtime unhealthy when only the second agent fails', async () => {
    const deployed = loadConfig({ ...env, ...parseEnv(pilotHostFiles(plan)['routing.env']!) });
    const request = vi.fn<typeof fetch>(async input => new Response('', { status: String(input).includes(':8643') ? 503 : 200 }));
    vi.stubGlobal('fetch', request);
    try {
      await expect(new HermesAgentRuntime(deployed.hermes).health()).rejects.toThrow('503');
      expect(request.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:8642/health', 'http://127.0.0.1:8643/health']);
    } finally { vi.unstubAllGlobals(); }
  });
});
