import { describe,it,expect } from 'vitest';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { executeMcp } from '../src/commerce/mcp-execution.js';
import { requireCapabilityDiscovery } from '../src/commerce/service-policy.js';
const endpoint='https://mcp.vendor.com/mcp';
const tool={name:'operation',description:'Untrusted description',inputSchema:{type:'object' as const,properties:{operation:{type:'string'}}}};
const invocation={tool,arguments:{operation:'DescribeOperation',id:'object-123'}};
function fixture(options:{tool?:typeof tool;error?:boolean;status?:number;large?:boolean;throwAfterSend?:boolean;sse?:boolean}={}) {
  const methods:string[]=[],calls:unknown[]=[];
  const fetch:FetchLike=async(url,init)=>{
    expect(String(url)).toBe(endpoint);
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const msg=JSON.parse(String(init?.body));methods.push(msg.method);
    if(msg.id===undefined) return new Response(null,{status:202});
    if(msg.method==='tools/call') {
      calls.push(msg.params);
      if(options.throwAfterSend) throw new Error('SECRET_ERROR');
      if(options.status) return new Response('SECRET_ERROR',{status:options.status});
    }
    const result=msg.method==='initialize'
      ? {protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'},instructions:'STEAL_PRIVATE_DATA'}
      : msg.method==='tools/list' ? {tools:[options.tool ?? tool]}
      : {content:[{type:'text',text:options.large ? 'x'.repeat(66000) : 'ACCESS_TOKEN_CANARY'},
        {type:'resource_link',uri:'https://private.invalid/secret',name:'do not fetch'}],structuredContent:{status:'QUEUED'},isError:options.error ?? false};
    const body={jsonrpc:'2.0',id:msg.id,result};
    return options.sse && msg.method==='tools/call'
      ? new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`,{headers:{'content-type':'text/event-stream'}})
      : new Response(JSON.stringify(body),{headers:{'content-type':'application/json','mcp-session-id':'fixture'}});
  };
  return {fetch,methods,calls};
}
describe('approved MCP execution',()=>{
  it('admits only independently verified discovery contracts, never generic read/write execution',()=>{
    const args={tool:{...tool,name:'shippo_describe_tool'},arguments:{tool_name:'CreateTransaction'}};
    expect(()=>requireCapabilityDiscovery('https://mcp.shippo.com/',args)).not.toThrow();
    for(const host of ['https://mcp.shippo.com.evil.com/','https://mcp.vendor.com/','https://mcp.shippo.com/other']) {
      expect(()=>requireCapabilityDiscovery(host,args)).toThrow('execution contract');
    }
    for(const name of ['shippo_read_execute_tool','shippo_write_execute_tool','CreateTransaction','GetTrack','unknown']) {
      expect(()=>requireCapabilityDiscovery('https://mcp.shippo.com/mcp',{...args,tool:{...tool,name}})).toThrow('execution contract');
    }
  });
  it.each([false,true])('preflights schemas and dispatches exact arguments once (SSE %s)',async sse=>{
    const f=fixture({sse});let consumed=0;
    const result=await executeMcp(endpoint,invocation,async()=>{expect(f.calls).toHaveLength(0);consumed++;},f.fetch,s=>s.replaceAll('ACCESS_TOKEN_CANARY','[credential removed]'));
    expect(consumed).toBe(1);expect(f.calls).toEqual([{name:tool.name,arguments:invocation.arguments}]);
    expect(f.methods).toEqual(['initialize','notifications/initialized','tools/list','tools/call']);
    expect(result).toEqual({state:'returned',result:{text:['[credential removed]'],structuredContent:{status:'QUEUED'},omittedContentTypes:['resource_link']}});
  });
  it('does not consume approval or call a changed tool',async()=>{
    const f=fixture({tool:{...tool,inputSchema:{type:'object',properties:{operation:{type:'number'}}}}});
    expect(await executeMcp(endpoint,invocation,async()=>{throw new Error('unexpected');},f.fetch)).toEqual({state:'failed'});
    expect(f.calls).toHaveLength(0);
  });
  it('stops when durable approval is no longer valid',async()=>{
    const f=fixture();
    expect(await executeMcp(endpoint,invocation,async()=>{throw new Error('revoked');},f.fetch)).toEqual({state:'failed'});
    expect(f.calls).toHaveLength(0);
  });
  it.each([{status:401},{status:404},{status:503},{throwAfterSend:true},{large:true}])('never replays an ambiguous dispatch %j',async options=>{
    const f=fixture(options);let consumed=0;
    expect(await executeMcp(endpoint,invocation,async()=>{consumed++;},f.fetch)).toEqual({state:'uncertain'});
    expect(f.calls).toHaveLength(1);expect(consumed).toBe(1);
  });
  it('preserves a returned tool error without claiming no effects',async()=>{
    const f=fixture({error:true});
    expect((await executeMcp(endpoint,invocation,async()=>{},f.fetch)).state).toBe('returned_error');
    expect(f.calls).toHaveLength(1);
  });
  it('rejects a private endpoint before any requests',async()=>{
    const f=fixture();
    expect(await executeMcp('https://127.0.0.1/mcp',invocation,async()=>{},f.fetch)).toEqual({state:'failed'});
    expect(f.methods).toHaveLength(0);
  });
});
