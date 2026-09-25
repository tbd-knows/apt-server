import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],
] as const) denied.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) denied.addSubnet(address,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !denied.check(address,'ipv4')
    : family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}

/** No userinfo, query tokens, fragments, alternate ports, IP literals or local names.
 * DNS is separately validated and pinned on every socket, including SDK retries. */
export function publicEndpoint(value: string) {
  if (value.length > 2000 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search
    && (!url.port || url.port === '443') && url.hostname.includes('.') && !isIP(url.hostname)
    && !url.hostname.includes(':') && !url.hostname.endsWith('.')
    && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname)
    && url.hostname !== 'metadata.google.internal';
}

export class PublicHttpError extends Error {
  constructor() { super('Public service request could not be completed safely.'); }
}

/** Single-endpoint, bounded HTTPS fetch for an MCP session. Never uses ambient
 * proxy/cookies or follows redirects. TLS still validates the original hostname. */
export function publicEndpointFetch(endpoint: string, options: { metadata?: boolean; bearer?: string; exposeChallenge?: boolean } = {}): FetchLike {
  if (!publicEndpoint(endpoint)) throw new PublicHttpError();
  return boundedEndpointFetch(endpoint, options);
}
/** Public carrier documents only; no cookies, bearer credentials or JavaScript.
 * The single supported query is a server-derived public location identifier. */
export function publicLocationFetch(endpoint: string, format: 'html' | 'json'): FetchLike {
  const url = new URL(endpoint);
  if (!publicEndpoint(`${url.origin}${url.pathname}`) || url.username || url.password || url.hash
    || (url.search && (url.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(url.searchParams.get('entityId') ?? '')))) throw new PublicHttpError();
  const fetcher = boundedEndpointFetch(endpoint, { metadata: true, document: format });
  return (input, init = {}) => {
    if ((init.method ?? 'GET') !== 'GET' || init.body) throw new PublicHttpError();
    return fetcher(input, init);
  };
}
function boundedEndpointFetch(endpoint: string, options: { metadata?: boolean; bearer?: string; exposeChallenge?: boolean; document?: 'html' | 'json' }): FetchLike {
  const expected = new URL(endpoint).href;
  const maxBytes = options.document === 'json' ? 3 * 1_048_576 : 1_048_576;
  return async (input,init = {}) => {
    const url = new URL(input);
    if (url.href !== expected || !['POST','GET','DELETE'].includes(init.method ?? 'GET')) throw new PublicHttpError();
    // Inspection does not subscribe to unsolicited server requests/events.
    if ((init.method ?? 'GET') === 'GET' && !options.metadata) return new Response(null,{status:405});
    if (init.body != null && (typeof init.body !== 'string' || Buffer.byteLength(init.body)>65536)) throw new PublicHttpError();
    const headers = new Headers(init.headers);
    const permitted = new Set(['accept','content-type','mcp-session-id','mcp-protocol-version']);
    for (const [key,value] of headers) if (!permitted.has(key) || value.length>4096) throw new PublicHttpError();
    if (options.bearer) {
      if (!/^[A-Za-z0-9._~+\/-]+=*$/.test(options.bearer) || options.bearer.length>8192) throw new PublicHttpError();
      headers.set('authorization',`Bearer ${options.bearer}`);
    }
    headers.set('accept-encoding','identity');
    headers.set('user-agent','TBD-service-inspection/1.0');
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]);
    const answers = await Promise.race([
      lookup(url.hostname,{all:true}),
      new Promise<never>((_,reject) => signal.addEventListener('abort',()=>reject(new PublicHttpError()),{once:true})),
    ]);
    if (signal.aborted || !answers.length || answers.some(a=>!publicAddress(a.address))) throw new PublicHttpError();
    const selected = answers[0]!;
    return new Promise<Response>((resolve,reject) => {
      const req = request(url,{
        method:init.method ?? 'GET',headers:Object.fromEntries(headers),agent:false,signal,
        lookup: (_hostname,options,callback) => {
          if (options.all) callback(null,[selected]);
          else callback(null,selected.address,selected.family);
        },
      },res => {
        const status = res.statusCode ?? 502;
        const responseHeaders = new Headers();
        for (const key of ['content-type','mcp-session-id']) {
          const value = res.headers[key];
          if (typeof value === 'string') responseHeaders.set(key,value);
        }
        if (options.exposeChallenge && status===401 && typeof res.headers['www-authenticate']==='string'
          && res.headers['www-authenticate'].length<=8192) responseHeaders.set('www-authenticate',res.headers['www-authenticate']);
        // Do not retain response bodies or headers from authentication failures,
        // redirects or other errors. OAuth discovery is a separate consent flow.
        if (status !== 200 && !(options.metadata && status===201)) {
          res.destroy(); resolve(new Response(null,{status,headers:responseHeaders})); return;
        }
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0]?.trim();
        if (!(options.document === 'html' ? ['text/html'] : options.document === 'json' ? ['application/json'] : ['application/json','text/event-stream']).includes(contentType ?? '')
          || !['','identity'].includes(String(res.headers['content-encoding'] ?? ''))
          || Number(res.headers['content-length'] ?? 0)>maxBytes) {
          res.destroy(); reject(new PublicHttpError()); return;
        }
        let size = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data',(chunk: Buffer) => {
              size += chunk.byteLength;
              if (size>maxBytes) { res.destroy(new PublicHttpError()); return; }
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on('end',()=>controller.close());
            res.on('error',()=>controller.error(new PublicHttpError()));
          },
          cancel() { res.destroy(); req.destroy(); },
        });
        resolve(new Response(body,{status,headers:responseHeaders}));
      });
      req.on('error',()=>reject(new PublicHttpError()));
      req.end(init.body ?? undefined);
    });
  };
}
