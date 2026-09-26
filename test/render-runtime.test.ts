import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe,expect,it } from 'vitest';
import { isolatedProcessEnvironment } from '../src/process-environment.js';
import { publicPilotPath,publicPilotProxy,renderPort } from '../src/render-runtime.js';

describe('Render private runtime boundary',()=>{
  it('never passes parent platform or other-provider credentials to Hermes',()=>{
    const source={PATH:'/bin',HOME:'/var/lib/tbd',LANG:'C',STRIPE_SECRET_KEY:'stripe',SUPABASE_SERVICE_ROLE_KEY:'supabase',
      HERMES_KEY_SECRET:'root',OPENAI_API_KEY:'other-owner',MOCK_KEY:'synthetic',APT_PUBLIC_URL:'public'};
    expect(isolatedProcessEnvironment(source)).toEqual({PATH:'/bin',HOME:'/var/lib/tbd',LANG:'C'});
  });
  it('rejects private, ambiguous and encoded paths while preserving app callbacks',()=>{
    for(const path of ['/internal/agent/tool','/v1/../internal/agent/tool','/v1/%2e%2e/internal','//internal','/.well-known/agent-card.json','/v1\\internal','/','/v1/%61'])expect(publicPilotPath(path)).toBe(false);
    for(const path of ['/health','/v1/chat/runs/abc/events','/webhooks/stripe','/commerce/connections/callback?code=secret','/commerce/connections/client.json','/commerce/return'])expect(publicPilotPath(path)).toBe(true);
    expect(renderPort('10000')).toBe(10000);
    for(const value of ['8787','8642','9901','0','65536','10000x',undefined])expect(()=>renderPort(value)).toThrow();
  });
  it('streams requests/responses unchanged and blocks private requests before upstream',async()=>{
    const received:string[]=[];
    const upstream=createServer(async(req,res)=>{
      received.push(req.url!);let body='';for await(const part of req)body+=part;
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
      res.write(`data: ${body}\n\n`);res.end('data: done\n\n');
    });
    upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
    const address=upstream.address();if(!address||typeof address==='string')throw new Error('No test port');
    const proxy=publicPilotProxy(address.port);proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
    const exposed=proxy.address();if(!exposed||typeof exposed==='string')throw new Error('No proxy port');
    try {
      const base=`http://127.0.0.1:${exposed.port}`;
      const response=await fetch(base+'/v1/commerce',{method:'POST',body:'raw webhook-like bytes'});
      expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.text()).toBe('data: raw webhook-like bytes\n\ndata: done\n\n');
      expect((await fetch(base+'/internal/agent/tool')).status).toBe(404);expect(received).toEqual(['/v1/commerce']);
    } finally {proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise<void>(r=>proxy.close(()=>r())),new Promise<void>(r=>upstream.close(()=>r()))]);}
  });
});
