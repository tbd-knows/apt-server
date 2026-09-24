import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CommerceConnections } from './connections.js';

export function connectionRoutes(app:FastifyInstance,connections:CommerceConnections,authenticate:(r:FastifyRequest)=>Promise<void>) {
  const options={preHandler:authenticate};
  const id=z.object({id:z.uuid()});
  app.post('/v1/commerce/service-actions/:id/decision',options,async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const body=z.union([
      z.object({digest:z.string().length(64),approve:z.literal(true),approveCapabilityDiscovery:z.literal(true)}).strict(),
      z.object({digest:z.string().length(64),approve:z.literal(true),approveFreeAddressValidation:z.literal(true)}).strict(),
      z.object({digest:z.string().length(64),approve:z.literal(false)}).strict(),
    ]).parse(r.body);
    if('approveFreeAddressValidation' in body) return connections.decideAction(r.userId!,id.parse(r.params).id,body.digest,body.approve,'free_address_validation');
    return connections.decideAction(r.userId!,id.parse(r.params).id,body.digest,body.approve);
  });
  app.post('/v1/commerce/exchanges/:id/connections',options,async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const body=z.object({researchId:z.uuid()}).strict().parse(r.body);
    return connections.prepare(r.userId!,id.parse(r.params).id,body.researchId);
  });
  app.post('/v1/commerce/connections/:id/authorize',options,async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const body=z.object({bindingDigest:z.string().length(64)}).strict().parse(r.body);
    return connections.start(r.userId!,id.parse(r.params).id,body.bindingDigest);
  });
  app.post('/v1/commerce/connections/:id/recheck',options,async(r,reply)=>{
    reply.header('Cache-Control','private, no-store');
    return connections.recheck(r.userId!,id.parse(r.params).id);
  });
  app.post('/v1/commerce/connections/:id/disconnect',options,r=>connections.disconnect(r.userId!,id.parse(r.params).id));
  app.get('/commerce/connections/client.json',async(_r,reply)=>{
    reply.header('Cache-Control','public, max-age=300');
    return new URL(connections.publicUrl).protocol==='https:'
      ? {client_id:`${connections.publicUrl}/commerce/connections/client.json`,client_name:'TBD personal commerce agent',
        redirect_uris:[`${connections.publicUrl}/commerce/connections/callback`],grant_types:['authorization_code','refresh_token'],
        response_types:['code'],token_endpoint_auth_method:'none'} : reply.code(503).send();
  });
  app.get('/commerce/connections/callback',async(r,reply)=>{
    const query=z.object({state:z.string().max(100),code:z.string().max(8192).optional(),error:z.string().max(200).optional()}).safeParse(r.query);
    const ok=query.success && await connections.callback(query.data.state,query.data.code,!!query.data.error);
    return reply.type('text/html').header('Cache-Control','no-store').header('Referrer-Policy','no-referrer')
      .header('Content-Security-Policy',"default-src 'none'; style-src 'none'; frame-ancestors 'none'; base-uri 'none'")
      .send(`<!doctype html><meta name="viewport" content="width=device-width"><title>TBD service connection</title><p>${ok?'Service access checked. Return to your agent to review the next step.':'Connection did not complete. Return to the app to review or reconnect.'}</p><p><a href="aptmobile://commerce-return">Return to the app</a></p>`);
  });
}
