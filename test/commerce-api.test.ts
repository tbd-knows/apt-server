import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { CommerceService } from '../src/commerce/service.js';
import { CommerceConnections } from '../src/commerce/connections.js';
import { StripeProvider, providerConfig } from '../src/commerce/providers.js';
import { auth, config, instance, repository, runtime, turn, USER_A, USER_B } from './fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
describe('commerce API and isolated agent delivery', () => {
  it('continues to the other owner when one profile fails, leaving the failed wake pending', async () => {
    const idA = '88888888-8888-4888-8888-888888888888', idB = '99999999-9999-4999-8999-999999999999';
    const delivered = vi.fn(async () => {});
    const commerce = { authorize: vi.fn(), pendingAgentMessages: async () => [
      { id: idA, recipient_id: USER_A, exchange_id: idA }, { id: idB, recipient_id: USER_B, exchange_id: idB },
    ], markAgentDelivered: delivered } as unknown as CommerceService;
    const getAgentInstance = vi.fn(async (actor: string) => {
      if (actor === USER_A) throw new Error('PRIVATE_UPSTREAM_FAILURE');
      return { ...instance, userId: USER_B, hermesProfileName: 'apt-user-b' };
    });
    const app = await buildApp({ config, auth: auth(), repository: repository({ getAgentInstance }), runtime: runtime(), commerceService: commerce });
    apps.push(app); await app.ready();
    await vi.waitFor(() => expect(delivered).toHaveBeenCalledWith(idB));
    expect(delivered).not.toHaveBeenCalledWith(idA);
  });
  it('authenticates and gates every commerce path before object or provider access', async () => {
    const service = new CommerceService({} as never, [USER_A, USER_B], 'test');
    const app = await buildApp({ config, auth: { authenticate: async () => ({ id: '99999999-9999-4999-8999-999999999999' }) }, repository: repository(), runtime: runtime(), commerceService: service,
      commerceStripe:new StripeProvider(providerConfig({APT_PUBLIC_URL:'https://app.tbd.com'},'test')) });
    apps.push(app);
    for (const [method, url] of [['GET','/v1/commerce'], ['GET','/v1/commerce/inbox'], ['GET','/v1/commerce/preferences'], ['POST','/v1/commerce/requests'], ['POST',`/v1/commerce/exchanges/${USER_A}/actions`],
      ['POST',`/v1/commerce/exchanges/${USER_A}/connections`],['POST',`/v1/commerce/connections/${USER_A}/authorize`],
      ['POST',`/v1/commerce/connections/${USER_A}/recheck`],['POST',`/v1/commerce/connections/${USER_A}/disconnect`],
      ['POST',`/v1/commerce/service-actions/${USER_A}/decision`]] as const) {
      const response = await app.inject({ method, url, headers: { authorization: 'Bearer third-user' }, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(response.statusCode).toBe(403);
    }
    const metadata=await app.inject({url:'/commerce/connections/client.json'});
    expect(metadata.json().redirect_uris).toEqual(['https://app.tbd.com/commerce/connections/callback']);
    const callback=await app.inject({url:'/commerce/connections/callback?state=invalid&code=PRIVATE_CODE_CANARY&error_description=REMOTE_CANARY'});
    expect(callback.statusCode).toBe(200);expect(callback.body).not.toContain('CANARY');
    expect(callback.headers['referrer-policy']).toBe('no-referrer');
    expect(callback.headers['cache-control']).toBe('no-store');
  });
  it('requires explicit discovery acceptance and never accepts edited arguments with approval',async()=>{
    const service=new CommerceService({} as never,[USER_A,USER_B],'test');
    const app=await buildApp({config,auth:auth(),repository:repository(),runtime:runtime(),commerceService:service,
      commerceStripe:new StripeProvider(providerConfig({APT_PUBLIC_URL:'https://app.tbd.com'},'test'))});apps.push(app);
    const decide=vi.spyOn(CommerceConnections.prototype,'decideAction').mockResolvedValue({state:'returned'} as never);
    try {
      const digest='a'.repeat(64),url=`/v1/commerce/service-actions/${USER_A}/decision`;
      for(const payload of [{approve:true,digest},{approve:true,digest,approveCapabilityDiscovery:false},
        {approve:true,digest,approveCapabilityDiscovery:true,arguments:{changed:true}},
        {approve:false,digest,approveCapabilityDiscovery:true}]) {
        expect((await app.inject({method:'POST',url,headers:{authorization:'Bearer token-a'},payload})).statusCode).toBe(400);
      }
      expect(decide).not.toHaveBeenCalled();
      const result=await app.inject({method:'POST',url,headers:{authorization:'Bearer token-a'},payload:{approve:true,digest,approveCapabilityDiscovery:true}});
      expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('private, no-store');
      expect(decide).toHaveBeenCalledWith(USER_A,USER_A,digest,true);
    } finally {decide.mockRestore();}
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
