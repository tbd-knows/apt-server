import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { auth, config, repository, RUN_ID, runtime, USER_A, USER_B } from './fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function appWith(repositoryOverrides = {}) {
  const repo = repository(repositoryOverrides);
  const app = await buildApp({ config, auth: auth(), repository: repo, runtime: runtime() });
  apps.push(app);
  await app.ready();
  return { app, repo };
}

describe('chat API', () => {
  it('requires a valid bearer token on every chat route', async () => {
    const { app } = await appWith();
    for (const request of [
      { method: 'GET', url: '/v1/chat' },
      { method: 'POST', url: '/v1/chat/messages', payload: {} },
      { method: 'GET', url: `/v1/chat/runs/${RUN_ID}` },
      { method: 'GET', url: `/v1/chat/runs/${RUN_ID}/events` },
      { method: 'POST', url: `/v1/chat/runs/${RUN_ID}/stop` },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('scopes history reads to the authenticated user and accepts keyset parameters', async () => {
    const getChat = vi.fn(async () => ({ messages: [], olderCursor: '10', activeRun: null }));
    const { app } = await appWith({ getChat });
    const response = await app.inject({ method: 'GET', url: '/v1/chat?before=42&limit=25', headers: { authorization: 'Bearer token-a' } });
    expect(response.statusCode).toBe(200);
    expect(getChat).toHaveBeenCalledWith(USER_A, '42', 25);
  });

  it('returns a stable error when the user is not provisioned', async () => {
    const { app } = await appWith({ getAgentInstance: vi.fn(async () => null) });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: 'hello' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'AGENT_NOT_PROVISIONED', message: 'Apt chat has not been provisioned for this user.' } });
  });

  it('normalizes a message and preserves the idempotency key', async () => {
    const createTurn = vi.fn(async () => (await import('./fixtures.js')).turn());
    const { app } = await appWith({ createTurn });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: '  hello\r\nworld  ' } });
    expect(response.statusCode).toBe(202);
    expect(createTurn).toHaveBeenCalledWith(USER_A, '77777777-7777-4777-8777-777777777777', 'hello\nworld');
  });

  it('ignores a stale client\'s foreground location instead of storing or rejecting it', async () => {
    const createTurn = vi.fn(async () => (await import('./fixtures.js')).turn());
    const agentRuntime = runtime();
    const repo = repository({ createTurn });
    const app = await buildApp({ config, auth: auth(), repository: repo, runtime: agentRuntime });
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/messages',
      headers: { authorization: 'Bearer token-a' },
      payload: {
        clientMessageId: '77777777-7777-4777-8777-777777777777',
        content: 'Find groceries nearby',
        location: { latitude: 40.7, longitude: -74, accuracy: 25, capturedAt: new Date().toISOString(), coarseLabel: 'New York, NY, US' },
      },
    });
    expect(response.statusCode).toBe(202);
    expect(createTurn).toHaveBeenCalledWith(USER_A, '77777777-7777-4777-8777-777777777777', 'Find groceries nearby');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.stringify(vi.mocked(agentRuntime.submit).mock.calls)).not.toContain('40.7');
  });

  it('serves no retired Shopping or Claw routes', async () => {
    const { app } = await appWith();
    for (const request of [
      { method: 'GET', url: '/v1/shopping/summary' },
      { method: 'GET', url: '/v1/cart' },
      { method: 'POST', url: '/v1/cart/items', payload: {} },
      { method: 'GET', url: '/v1/wishlist' },
      { method: 'GET', url: '/v1/boards' },
      { method: 'POST', url: '/internal/claw/tool', payload: {} },
    ] as const) {
      const response = await app.inject({ ...request, headers: { authorization: 'Bearer token-a' } });
      expect(response.statusCode, request.url).toBe(404);
    }
  });

  it('accepts only the three private-context tools on the agent bridge', async () => {
    const { MemoryService } = await import('../src/memory/service.js');
    const memoryService = new MemoryService({} as never);
    const app = await buildApp({ config, auth: auth(), repository: repository(), runtime: runtime(), memoryService });
    apps.push(app);
    await app.ready();
    const { aptBridgeToken } = await import('../src/memory/bridge-auth.js');
    const token = aptBridgeToken('apt-0123456789abcdef0123', config.hermes.keySecret);
    for (const tool of ['apt_commerce_hunt', 'apt_manage_shopping', 'apt_get_shopping_state', 'apt_previous_hunts', 'apt_propose_shared_change']) {
      const response = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${token}` }, payload: { tool, arguments: {} } });
      expect(response.statusCode, tool).toBe(400);
    }
    const inactive = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: `Bearer ${token}` }, payload: { tool: 'apt_search_knowledge', arguments: { query: 'x' } } });
    expect(inactive.statusCode).toBe(404);
    const forged = await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { authorization: 'Bearer apt-0123456789abcdef0123.forged' }, payload: { tool: 'apt_search_knowledge', arguments: { query: 'x' } } });
    expect(forged.statusCode).toBe(401);
  });

  it('returns the original turn for an idempotent duplicate without starting Hermes again', async () => {
    const existing = { ...(await import('./fixtures.js')).turn(), duplicate: true };
    const createTurn = vi.fn(async () => existing);
    const agentRuntime = runtime();
    const repo = repository({ createTurn });
    const app = await buildApp({ config, auth: auth(), repository: repo, runtime: agentRuntime });
    apps.push(app);
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: 'hello' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().duplicate).toBe(true);
    expect(agentRuntime.submit).not.toHaveBeenCalled();
  });

  it('returns a stable conflict while another turn is active', async () => {
    const createTurn = vi.fn(async () => { throw new AppError('RUN_IN_PROGRESS', 'Wait for the active response or stop it first.'); });
    const { app } = await appWith({ createTurn });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: 'hello' } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('RUN_IN_PROGRESS');
  });

  it('does not reveal another user\'s run or event stream', async () => {
    const getRun = vi.fn(async (userId: string) => {
      if (userId === USER_B) throw new AppError('RUN_NOT_FOUND', 'Run not found.');
      return (await import('./fixtures.js')).run();
    });
    const { app } = await appWith({ getRun });
    for (const suffix of ['', '/events']) {
      const response = await app.inject({ method: 'GET', url: `/v1/chat/runs/${RUN_ID}${suffix}`, headers: { authorization: 'Bearer token-b' } });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('RUN_NOT_FOUND');
    }
    const stop = await app.inject({ method: 'POST', url: `/v1/chat/runs/${RUN_ID}/stop`, headers: { authorization: 'Bearer token-b' } });
    expect(stop.statusCode).toBe(404);
    expect(stop.json().error.code).toBe('RUN_NOT_FOUND');
  });

  it('emits only sanitized application events for a terminal run', async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: 'GET', url: `/v1/chat/runs/${RUN_ID}/events`, headers: { authorization: 'Bearer token-a' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: run.snapshot');
    expect(response.body).not.toContain('hermesProfileName');
  });

  it('fails unfinished runs exactly once during startup recovery', async () => {
    const failUnfinishedRuns = vi.fn(async () => []);
    await appWith({ failUnfinishedRuns });
    expect(failUnfinishedRuns).toHaveBeenCalledOnce();
  });
});
