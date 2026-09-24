import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike,Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { digest } from './domain.js';
import { readMcpCatalog,type McpInspection } from './mcp-inspection.js';
import { publicEndpoint,publicEndpointFetch } from './public-http.js';

export interface ServiceInvocation {
  tool:McpInspection['tools'][number];
  arguments:Record<string,unknown>;
  shippingRates?: { consentId:string; descriptionActionId:string; operationId:string; sourceActionId?:string };
  shippingValidation?: { consentId:string; addressOwnerId:string; addressVersion:number; descriptionActionId:string };
}
export interface ServiceResult {
  state:'returned'|'returned_error'|'failed'|'uncertain';
  result?:{text:string[];structuredContent?:Record<string,unknown>;omittedContentTypes:string[]};
}

/** Exactly one tools/call transport attempt. No automatic retry, token refresh,
 * remote schema compilation, resource fetch, elicitation, sampling or roots.
 * beforeDispatch durably records permission consumption before network I/O. */
export async function executeMcp(endpoint:string,invocation:ServiceInvocation,beforeDispatch:()=>Promise<void>,
  fetcher?:FetchLike,redact:(value:string)=>string=value=>value):Promise<ServiceResult> {
  if(!publicEndpoint(endpoint)) return {state:'failed'};
  const signal=AbortSignal.timeout(25_000),fetch=fetcher ?? publicEndpointFetch(endpoint);
  let requests=0,calls=0,dispatched=false;
  const transport=new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch:async(url,init)=>{
      if(++requests>16 || new URL(url).href!==new URL(endpoint).href) throw new Error('Execution limit');
      if(init?.body) {
        const message=JSON.parse(String(init.body)) as {method?:string;params?:unknown};
        if(message.method==='tools/call') {
          if(++calls!==1 || digest(message.params)!==digest({name:invocation.tool.name,arguments:invocation.arguments})) throw new Error('Call denied');
          await beforeDispatch();
          dispatched=true;
        } else if(message.method && !['initialize','notifications/initialized','tools/list','notifications/cancelled'].includes(message.method)) throw new Error('Method denied');
      }
      return fetch(url,{...init,signal:AbortSignal.any([signal,...(init?.signal ? [init.signal] : [])])});
    },
    reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1},
  });
  const client=new Client({name:'tbd-approved-service-action',version:'1.0.0'},{capabilities:{}});
  try {
    await client.connect(transport as Transport,{signal,timeout:10_000});
    if(!client.getServerCapabilities()?.tools) return {state:'failed'};
    const catalog=JSON.parse(redact(JSON.stringify(await readMcpCatalog(client,signal)))) as McpInspection['tools'];
    if(digest(catalog.find(tool=>tool.name===invocation.tool.name) ?? null)!==digest(invocation.tool)) return {state:'failed'};
    const answer=await client.request({method:'tools/call',params:{name:invocation.tool.name,arguments:invocation.arguments}},CallToolResultSchema,{signal,timeout:15_000});
    if(Buffer.byteLength(JSON.stringify(answer))>65536) return {state:'uncertain'};
    const result={text:answer.content.flatMap(part=>part.type==='text' ? [part.text] : []),
      ...(answer.structuredContent ? {structuredContent:answer.structuredContent} : {}),
      omittedContentTypes:[...new Set(answer.content.filter(part=>part.type!=='text').map(part=>part.type))]};
    return {state:answer.isError ? 'returned_error' : 'returned',result:JSON.parse(redact(JSON.stringify(result))) as typeof result};
  } catch {return {state:dispatched?'uncertain':'failed'};}
  finally {
    if(transport.sessionId) await transport.terminateSession().catch(()=>{});
    await client.close().catch(()=>{});
  }
}
