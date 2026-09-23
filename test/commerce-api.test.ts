import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { CommerceService } from '../src/commerce/service.js';
import { auth, config, instance, repository, runtime, turn, USER_A, USER_B } from './fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
describe('commerce API and isolated agent delivery', () => {
  it('authenticates and gates every commerce path before object or provider access', async () => {
    const service = new CommerceService({} as never, [USER_A, USER_B], 'test');
    const app = await buildApp({ config, auth: { authenticate: async () => ({ id: '99999999-9999-4999-8999-999999999999' }) }, repository: repository(), runtime: runtime(), commerceService: service });
    apps.push(app);
    for (const [method, url] of [['GET','/v1/commerce'], ['GET','/v1/commerce/inbox'], ['GET','/v1/commerce/preferences'], ['POST','/v1/commerce/requests'], ['POST',`/v1/commerce/exchanges/${USER_A}/actions`]] as const) {
      const response = await app.inject({ method, url, headers: { authorization: 'Bearer third-user' }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(403);
    }
  });
  it('rejects external and forwarded access to the internal tool bridge before credentials', async () => {
    const app = await buildApp({ config, auth: auth(), repository: repository(), runtime: runtime() }); apps.push(app);
    for (const remoteAddress of ['203.0.113.10','192.168.1.2']) {
      expect((await app.inject({ method: 'POST', url: '/internal/agent/tool', remoteAddress, payload: {} })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'POST', url: '/internal/agent/tool', headers: { 'x-forwarded-for': '203.0.113.10' }, payload: {} })).statusCode).toBe(404);
  });
  it('wakes only the durable message recipient with a stable retry identity and no private sender context', async () => {
    const id = '88888888-8888-4888-8888-888888888888';
    const markAgentDelivered = vi.fn(async () => {});
    const exchangeId = '99999999-9999-4999-8999-999999999999';
    const commerce = { authorize: vi.fn(), pendingAgentMessages: vi.fn(async () => [{ id, recipient_id: USER_B, exchange_id: exchangeId }]), markAgentDelivered } as unknown as CommerceService;
    const createTurn = vi.fn(async () => turn());
    const getAgentInstance = vi.fn(async () => ({ ...instance, userId: USER_B, hermesProfileName: 'apt-user-b' }));
    const app = await buildApp({ config, auth: auth(), repository: repository({ createTurn, getAgentInstance }), runtime: runtime(), commerceService: commerce }); apps.push(app);
    await app.ready();
    await vi.waitFor(() => expect(markAgentDelivered).toHaveBeenCalledWith(id));
    expect(getAgentInstance).toHaveBeenCalledWith(USER_B);
    expect(createTurn).toHaveBeenCalledWith(USER_B, id, expect.stringContaining('untrusted'));
    expect(createTurn).toHaveBeenCalledWith(USER_B, id, expect.stringContaining(exchangeId));
    expect(createTurn.mock.calls[0]).not.toContain(USER_A);
  });
});
