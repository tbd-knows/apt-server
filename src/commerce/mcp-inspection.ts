import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { publicEndpoint, publicEndpointFetch } from './public-http.js';
import { digest } from './domain.js';

export interface McpInspection {
  status: 'inspected' | 'authorization_required' | 'unavailable';
  transport: 'streamable_http';
  tools: Array<{ name: string; description: string; inputSchema: Record<string,unknown>; outputSchema?: Record<string,unknown> }>;
  schemaDigest?: string;
  authHint?: { resourceMetadataUrl?: string; scope?: string };
  authority: 'untrusted_capabilities_only';
}

export async function readMcpCatalog(client:Client,signal:AbortSignal) {
  const tools:McpInspection['tools']=[];
  let cursor:string|undefined,bytes=0;
  const cursors=new Set<string>(),names=new Set<string>();
  do {
    const page=await client.request({method:'tools/list',params:cursor ? {cursor} : {}},ListToolsResultSchema,{signal,timeout:10_000});
    for(const tool of page.tools) {
      bytes+=Buffer.byteLength(JSON.stringify(tool));
      if(bytes>196608 || names.size>=64 || names.has(tool.name) || tool.name.length>128
        || (tool.description?.length ?? 0)>4000 || Buffer.byteLength(JSON.stringify(tool.inputSchema))>24000
        || Buffer.byteLength(JSON.stringify(tool.outputSchema ?? {}))>24000) throw new Error('Capability limit');
      names.add(tool.name);
      tools.push({name:tool.name,description:tool.description ?? '',inputSchema:tool.inputSchema,
        ...(tool.outputSchema ? {outputSchema:tool.outputSchema} : {})});
    }
    cursor=page.nextCursor;
    if(cursor && (cursors.has(cursor) || cursors.size>=4 || cursor.length>2048)) throw new Error('Pagination limit');
    if(cursor) cursors.add(cursor);
  } while(cursor);
  return tools.sort((a,b)=>a.name.localeCompare(b.name));
}

/** Protocol inspection only. No tools/call, roots, sampling, prompts, resources,
 * elicitation, OAuth or credentials. Remote descriptions/annotations are claims,
 * never evidence of permission, provider identity, or safe/idempotent execution. */
export async function inspectMcp(endpoint: string, fetcher?: FetchLike): Promise<McpInspection> {
  const result: McpInspection = {status:'unavailable',transport:'streamable_http',tools:[],authority:'untrusted_capabilities_only'};
  if (!publicEndpoint(endpoint)) return result;
  const signal = AbortSignal.timeout(25_000);
  const fetch = fetcher ?? publicEndpointFetch(endpoint,{exposeChallenge:true});
  let requests = 0;
  const transport = new StreamableHTTPClientTransport(new URL(endpoint),{
    fetch: async (url,init) => {
      if (++requests>16 || new URL(url).href !== new URL(endpoint).href) throw new Error('Inspection limit');
      if (init?.body) {
        const message = JSON.parse(String(init.body)) as {method?:string};
        if (message.method && !['initialize','notifications/initialized','tools/list','notifications/cancelled'].includes(message.method)) throw new Error('Inspection method denied');
      }
      const response = await fetch(url,{...init,signal:AbortSignal.any([signal,...(init?.signal ? [init.signal] : [])])});
      if (init?.method!=='DELETE' && (response.status===401 || response.status===403)) {
        result.status='authorization_required';
        const hint=extractWWWAuthenticateParams(response);
        const metadata=hint.resourceMetadataUrl?.href;
        const scope=hint.scope;
        if (metadata && publicEndpoint(metadata) || scope && scope.length<=2000) result.authHint={
          ...(metadata && publicEndpoint(metadata) ? {resourceMetadataUrl:metadata} : {}),
          ...(scope && scope.length<=2000 ? {scope} : {}),
        };
      }
      return response;
    },
    reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1},
  });
  const client = new Client({name:'tbd-service-inspection',version:'1.0.0'},{capabilities:{}});
  try {
    // SDK 1.30 exposes sessionId as string|undefined on its concrete transport,
    // while Transport declares it optional; compatible at runtime.
    await client.connect(transport as Transport,{signal,timeout:15_000});
    if (!client.getServerCapabilities()?.tools) return result;
    result.tools=await readMcpCatalog(client,signal);
    result.schemaDigest = digest(result.tools);
    result.status = 'inspected';
    return result;
  } catch {
    return {...result,tools:[]};
  } finally {
    // Do not retain remote session IDs or remote error prose in durable results.
    if (transport.sessionId) await transport.terminateSession().catch(()=>{});
    await client.close().catch(()=>{});
  }
}
