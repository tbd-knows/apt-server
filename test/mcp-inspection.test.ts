import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectMcp } from '../src/commerce/mcp-inspection.js';
import { publicAddress, publicEndpoint, publicEndpointFetch } from '../src/commerce/public-http.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const endpoint='https://mcp.vendor.com/mcp';
const tool={name:'track_package',description:'Tracks a package; does not buy postage.',inputSchema:{type:'object',properties:{trackingNumber:{type:'string'}}}};
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0)) await close();});
async function fixture(options: {sse?:boolean;auth?:boolean;hostile?:boolean;page?:(cursor?:string)=>unknown}={}) {
  const messages: Array<Record<string,unknown>>=[];
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE') {res.writeHead(200);res.end();return;}
    if(req.method==='GET') {res.writeHead(405);res.end();return;}
    if(options.auth) {res.writeHead(401,{'www-authenticate':'Bearer realm="SECRET_REMOTE_ERROR"'});res.end('SECRET_REMOTE_ERROR');return;}
    let body='';for await(const part of req) body+=String(part);
    const message=JSON.parse(body) as {id?:number;method?:string;params?:{cursor?:string}};
    messages.push(message);
    if(message.id===undefined || !message.method) {res.writeHead(202);res.end();return;}
    const result=message.method==='initialize'
      ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'Fixture',version:'1'},instructions:'HOSTILE_PRIVATE_PROMPT_REQUEST'}
      : options.page ? options.page(message.params?.cursor) : {tools:[tool]};
    if(options.sse && message.method==='tools/list') {
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(options.hostile) res.write(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:999,method:'sampling/createMessage',params:{messages:[]}})}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:message.id,result})}\n\n`);
    } else {
      res.writeHead(200,{'content-type':'application/json','mcp-session-id':'fixture-session'});
      res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address() as AddressInfo;
  // Only this fixture redirects transport requests to loopback. Production
  // inspectMcp defaults to the bounded, DNS-pinned public HTTPS transport.
  const fetch: FetchLike=async(url,init)=>{
    expect(String(url)).toBe(endpoint);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return globalThis.fetch(`http://127.0.0.1:${address.port}/mcp`,{...init,redirect:'error'});
  };
  return {fetch,messages};
}
describe('MCP capability inspection',()=>{
  it('uses real SDK handshake and paginated schemas without executing any tools',async()=>{
    const server=await fixture({page:cursor=>cursor ? {tools:[{...tool,name:'validate_address'}]} : {tools:[tool],nextCursor:'next'}});
    const result=await inspectMcp(endpoint,server.fetch);
    expect(result.status).toBe('inspected');
    expect(result.tools.map(t=>t.name)).toEqual(['track_package','validate_address']);
    expect(result.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(server.messages.map(m=>m.method)).toEqual(['initialize','notifications/initialized','tools/list','tools/list']);
    expect((server.messages[0]!.params as {capabilities:unknown}).capabilities).toEqual({});
    expect(JSON.stringify(result)).not.toContain('HOSTILE');
  });
  it('accepts SSE responses but denies server sampling and never returns private data',async()=>{
    const server=await fixture({sse:true,hostile:true});
    const result=await inspectMcp(endpoint,server.fetch);
    expect(result.status).toBe('inspected');
    expect(server.messages.some(m=>m.method==='tools/call')).toBe(false);
    expect(JSON.stringify(server.messages)).not.toContain('HOSTILE_PRIVATE');
  });
  it('records required authorization without exposing provider headers or error body',async()=>{
    const server=await fixture({auth:true});
    expect(await inspectMcp(endpoint,server.fetch)).toEqual({status:'authorization_required',tools:[],transport:'streamable_http',authority:'untrusted_capabilities_only'});
  });
  it('rejects partial catalogues, pagination loops and duplicate tool identities',async()=>{
    const loop=await fixture({page:()=>({tools:[],nextCursor:'same'})});
    expect((await inspectMcp(endpoint,loop.fetch)).status).toBe('unavailable');
    const duplicates=await fixture({page:()=>({tools:[tool,tool]})});
    expect((await inspectMcp(endpoint,duplicates.fetch)).tools).toEqual([]);
    const oversized=await fixture({page:()=>({tools:[{...tool,description:'x'.repeat(4001)}]})});
    expect((await inspectMcp(endpoint,oversized.fetch)).status).toBe('unavailable');
  });
  it('rejects unsafe endpoints before making any request',async()=>{
    for(const url of ['http://vendor.com/mcp','https://127.1/mcp','https://[::1]/mcp','https://user:pass@vendor.com/mcp','https://mcp.vendor.com/mcp?key=secret','https://mcp.vendor.com/mcp#key','https://mcp.vendor.com:8443/mcp','https://service.internal/mcp']) {
      expect(publicEndpoint(url)).toBe(false);
      expect(()=>publicEndpointFetch(url)).toThrow();
      expect((await inspectMcp(url,async()=>{throw new Error('must not contact');})).status).toBe('unavailable');
    }
    expect(publicEndpoint(endpoint)).toBe(true);
  });
  it('rejects private, special-purpose, mapped and transition DNS addresses',()=>{
    for(const ip of ['0.1.2.3','10.0.0.1','100.64.0.1','127.0.0.1','169.254.169.254','172.31.1.1','192.168.1.1','192.0.2.1','198.18.0.1','224.0.0.1','255.255.255.255','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::','64:ff9b::7f00:1','3fff::1']) expect(publicAddress(ip),ip).toBe(false);
    for(const ip of ['93.184.216.34','8.8.8.8','2606:4700:4700::1111']) expect(publicAddress(ip),ip).toBe(true);
  });
});
