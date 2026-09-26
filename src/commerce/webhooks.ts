import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { verifyEasyPostWebhook, verifyStripeWebhook, type ProviderConfig } from './providers.js';
import type { CommerceRepository } from './repository.js';

/** Persist only a verified event identity, then wake canonical provider retrieval. */
export async function commerceWebhooks(app: FastifyInstance, repository: CommerceRepository, config: ProviderConfig) {
  await app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_000_000 }, (_r, body, done) => done(null, body));
    scope.post('/webhooks/stripe', async request => {
      const event = verifyStripeWebhook(request.body as Buffer, String(request.headers['stripe-signature'] ?? ''), config.stripeWebhookSecret);
      if (event.livemode !== (config.mode === 'live') || (event.account && event.account !== config.stripeAccount)) throw new AppError('INVALID_MESSAGE', 'Unexpected Stripe account or mode.');
      const parsed = z.object({ id: z.string(), type: z.string(), data: z.object({ object: z.record(z.string(), z.unknown()) }) }).parse(event);
      const providerObject = parsed.data.object;
      // Checkout metadata binds early events to the operation committed before POST.
      const meta = z.object({ operation_id: z.uuid() }).safeParse(providerObject.metadata);
      const sessionId = typeof providerObject.id === 'string' && providerObject.object === 'checkout.session' ? providerObject.id : null;
      await repository.transaction(async sql => {
        const row = await sql.query(`select o.*,e.data from pilot_operations o join pilot_exchanges e on e.id=o.exchange_id
          where o.kind='checkout' and o.mode=$1 and (o.id=$2::uuid or o.provider_id=$3) limit 1`, [config.mode, meta.success ? meta.data.operation_id : null, sessionId]);
        if (!row.rows[0]) return;
        const op = row.rows[0];
        if (op.provider_id && sessionId && op.provider_id !== sessionId) throw new AppError('INVALID_MESSAGE', 'Payment object mismatch.');
        const inserted = await repository.event(sql, op.data, null, 'stripe_webhook', { eventId: parsed.id, type: parsed.type }, `stripe-webhook:${config.mode}:${parsed.id}`);
        if (inserted) await sql.query(`update pilot_operations set provider_id=coalesce(provider_id,$2),updated_at=now()-interval '1 minute',
          state=case when state='failed' then 'uncertain' else state end,attempts=least(attempts,4) where id=$1`, [op.id, sessionId]);
      });
      return { received: true };
    });
    scope.post('/webhooks/easypost', async request => {
      const event = verifyEasyPostWebhook(request.body as Buffer, String(request.headers['x-hmac-signature'] ?? ''), config.easyPostWebhookSecret);
      const parsed = z.object({ id: z.string(), user_id: z.literal(config.easyPostUser), mode: z.literal(config.mode === 'live' ? 'production' : 'test'), result: z.object({ id: z.string(), shipment_id: z.string().nullable().optional() }) }).parse(event);
      await repository.transaction(async sql => {
        const row = await sql.query(`select o.*,e.data from pilot_operations o join pilot_exchanges e on e.id=o.exchange_id
          where o.kind in ('label','return_label') and o.mode=$1 and (o.provider_id=$2 or o.result->>'trackerId'=$3) limit 1`, [config.mode, parsed.result.shipment_id ?? parsed.result.id, parsed.result.id]);
        if (!row.rows[0]) return;
        const op = row.rows[0];
        if (await repository.event(sql, op.data, null, 'shipping_webhook', { eventId: parsed.id }, `easypost-webhook:${config.mode}:${parsed.id}`)) {
          await sql.query("update pilot_operations set updated_at=now()-interval '1 minute' where id=$1", [op.id]);
        }
      });
      return { received: true };
    });
  });
}
