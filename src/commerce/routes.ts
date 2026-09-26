import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommerceService } from './service.js';
import type { CommerceAssets } from './assets.js';

export function commerceRoutes(app: FastifyInstance, service: CommerceService, authenticate: (r: FastifyRequest) => Promise<void>, assets?: CommerceAssets) {
  const options = { preHandler: authenticate };
  const params = z.object({ id: z.uuid() });
  app.get('/v1/commerce', options, r => service.list(r.userId!));
  app.get('/v1/commerce/inbox', options, r => service.inbox(r.userId!));
  app.post('/v1/commerce/inbox/:id/read', options, async r => {
    await service.readMessage(r.userId!, params.parse(r.params).id);
    return { ok: true };
  });
  app.get('/v1/commerce/preferences', options, r => service.preferences(r.userId!));
  app.post('/v1/commerce/preferences', options, r => service.preference(r.userId!, r.body));
  app.post('/v1/commerce/requests', options, r => {
    const input = z.object({ key: z.uuid(), input: z.unknown() }).strict().parse(r.body);
    return service.create(r.userId!, input.key, input.input);
  });
  app.get('/v1/commerce/exchanges/:id', options, r => service.get(r.userId!, params.parse(r.params).id));
  if (assets) {
    app.post('/v1/commerce/exchanges/:id/photos', { ...options, bodyLimit: 7_100_000 }, r => assets.upload(r.userId!, params.parse(r.params).id, r.body));
    app.get('/v1/commerce/photos/:id', options, async (r, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return assets.photo(r.userId!, params.parse(r.params).id);
    });
    app.get('/v1/commerce/exchanges/:id/label', options, async (r, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return assets.label(r.userId!, params.parse(r.params).id);
    });
    app.get('/v1/commerce/exchanges/:id/return-label', options, async (r, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      return assets.label(r.userId!, params.parse(r.params).id, true);
    });
  }
  app.post('/v1/commerce/exchanges/:id/actions', options, r => {
    const input = z.object({ key: z.uuid(), revision: z.number().int().positive(), command: z.unknown() }).strict().parse(r.body);
    return service.command(r.userId!, params.parse(r.params).id, input.key, input.revision, input.command);
  });
}
