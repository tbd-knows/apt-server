import { createServer, request as proxyRequest } from 'node:http';

export function renderPort(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) throw new Error('Render PORT must be an integer.');
  const port=Number(value);
  if(port<1024 || port>65535 || [8787,8642,8643,9900,9901].includes(port)) throw new Error('Render PORT conflicts with a private listener or is invalid.');
  return port;
}
export function publicPilotPath(raw: string) {
  // Check the same decoded path the router can interpret, and reject ambiguous
  // path encoding rather than forwarding it to a private service.
  if(!raw.startsWith('/') || raw.startsWith('//') || /[\\\r\n]/.test(raw)) return false;
  const path=raw.split('?')[0]!;
  if(/%|\/\.\.?($|\/)/.test(path)) return false;
  return path==='/health' || path.startsWith('/v1/') || [
    '/webhooks/stripe','/commerce/return','/commerce/connections/callback','/commerce/connections/client.json',
  ].includes(path);
}
/** Streaming proxy; only Fastify app routes are public, never Hermes/MCP/A2A. */
export function publicPilotProxy(port=8787) {
  const server=createServer((req,res)=>{
    if(!publicPilotPath(req.url??'')) {res.writeHead(404);res.end();return;}
    const headers={...req.headers};delete headers.connection;delete headers.upgrade;
    const upstream=proxyRequest({host:'127.0.0.1',port,path:req.url,method:req.method,headers},reply=>{
      res.writeHead(reply.statusCode??502,reply.headers);reply.pipe(res);
      reply.on('error',()=>res.destroy());
    });
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    req.on('aborted',()=>upstream.destroy());res.on('close',()=>upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade',(_req,socket)=>socket.destroy());
  return server;
}
