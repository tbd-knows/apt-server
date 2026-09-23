import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CommerceService } from './service.js';
import type { StripeProvider, ProviderConfig } from './providers.js';
import { AppError } from '../errors.js';

export function setupRoutes(app: FastifyInstance, commerce: CommerceService, stripe: StripeProvider, config: ProviderConfig, authenticate: (r: FastifyRequest) => Promise<void>) {
  app.get('/v1/commerce/setup', { preHandler: authenticate }, async request => {
    commerce.authorize(request.userId!);
    const accountId = config.connectedAccounts[request.userId!] ?? '';
    let sellerReady = false;
    if (accountId && config.stripeKey) { try { await stripe.accountReady(request.userId!); sellerReady = true; } catch { /* Explicit readiness state. */ } }
    return { mode: config.mode, sellerReady, connectedAccountConfigured: !!accountId,
      paymentConfigured: !!(config.stripeKey && config.stripeAccount && config.stripeWebhookSecret && config.publicUrl),
      shippingConfigured: !!(config.easyPostKey && config.easyPostUser && config.carrierAccount && config.easyPostWebhookSecret),
      locationsConfigured: !!(config.fedexKey && config.fedexSecret), economicsConfigured: !!(config.taxTreatment && config.subsidy),
      supportedScope: 'One physical item, US domestic, USD, card, FedEx Ground with a printed PDF',
    };
  });
  app.post('/v1/commerce/onboarding', { preHandler: authenticate }, async request => {
    commerce.authorize(request.userId!);
    const id = z.object({ key: z.uuid() }).strict().parse(request.body).key;
    await commerce.repository.transaction(async sql => {
      await sql.query(`insert into pilot_setup_operations(id,owner_id,mode,state) values($1,$2,$3,'pending') on conflict(id) do nothing`, [id, request.userId, config.mode]);
      const prior = await sql.query('select owner_id,mode from pilot_setup_operations where id=$1 for update', [id]);
      if (prior.rows[0].owner_id !== request.userId || prior.rows[0].mode !== config.mode) throw new AppError('NOT_FOUND', 'Setup action not found.');
    });
    const link = await stripe.onboarding(request.userId!, id);
    const url = z.url().parse(link.url);
    if (!url.startsWith('https://connect.stripe.com/')) throw new AppError('UPSTREAM_FAILED', 'Provider onboarding link is invalid.');
    await commerce.repository.pool.query("update pilot_setup_operations set state='succeeded' where id=$1", [id]);
    return { url };
  });
}
