/** Deterministic provider fakes against real disposable Postgres; no network/provider credentials. */
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { approve, approvalFor, createExchange, currentOffer, type Exchange, type Offer, type Operation, type OperationKind } from '../src/commerce/domain.js';
import { CommerceRepository, emptyPrivateInput } from '../src/commerce/repository.js';
import { CommerceService } from '../src/commerce/service.js';
import { CommerceWorker, type CommerceProviders } from '../src/commerce/worker.js';
import { ProviderFailure, providerConfig, type PaymentFact, type Shipment } from '../src/commerce/providers.js';
import { commerceWebhooks } from '../src/commerce/webhooks.js';
import { asAppError } from '../src/errors.js';

const url = process.env.APT_LOCAL_DATABASE_URL ?? '';
if (!URL.canParse(url) || !['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable loopback database required.');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const repository = new CommerceRepository(pool);
const A = '11111111-1111-4111-8111-111111111111'; const B = '22222222-2222-4222-8222-222222222222';
const service = new CommerceService(repository, [A, B], 'test');
const address = { name: 'Fixture', street1: '123 Fixture', street2: '', city: 'New York', state: 'NY', zip: '10001', country: 'US' as const, phone: '+12125550100' };
const packing = { weightOz: 32, lengthIn: 14, widthIn: 10, heightIn: 6, packed: true as const, canPrint: true };
const dropoff = { providerId: 'loc_fixture', name: 'Fixture', address: 'Fixture', hours: 'Fixture', checkedAt: new Date().toISOString(), mapUrl: 'https://example.test', carrier: 'FedEx', service: 'FEDEX_GROUND', artifact: 'pdf' as const };
async function fixture(): Promise<Exchange> {
  const e = createExchange(A, B, 'test', { item: 'Shoes', style: 'Low', size: '10', sizingSystem: 'US men', condition: 'Used' }, new Date());
  e.requestShared = true; e.stage = 'offered';
  const item = { itemId: randomUUID(), description: 'Real fixture item', size: '10', sizingSystem: 'US men' as const, condition: 'Used', defects: '', photoIds: [randomUUID()], sellerAmount: 5000 };
  const offer: Offer = { version: 1, item, buyerTotal: 6500, currency: 'USD', taxAmount: 0, feeAmount: 0, subsidy: 'Fixture', taxTreatment: 'Fixture', shipBy: new Date(Date.now()+86400000).toISOString(), expiresAt: new Date(Date.now()+3600000).toISOString(),
    quote: { shipmentId: `shp_${e.id}`, rateId: 'rate_fixture', carrierAccountId: 'ca_fixture', carrier: 'FedEx', service: 'FEDEX_GROUND', shippingAmount: 1500, currency: 'USD', expiresAt: new Date(Date.now()+3600000).toISOString(), estimatedDays: 3,
      originVersion: 1, destinationVersion: 1, packingVersion: 1, artifact: 'pdf', dropoff } };
  e.item = item; e.offers = [offer];
  approve(e, A, approvalFor(e, A), new Date()); approve(e, B, approvalFor(e, B), new Date());
  await repository.transaction(async sql => {
    await repository.insert(sql, e);
    for (const actor of [A, B]) await repository.savePrivate(sql, e, actor, { ...emptyPrivateInput(), address, addressVersion: 1, packing, packingVersion: 1, budget: 7000 });
  }); return e;
}
async function mutate(e: Exchange, patch: Partial<Exchange>) {
  await repository.transaction(async sql => { const current = await repository.get(e.id, A, sql, true); Object.assign(current, patch); await repository.save(sql, current, new Date()); });
}
async function queued(e: Exchange, kind: OperationKind, version = 1): Promise<Operation> {
  await repository.transaction(sql => repository.enqueue(sql, e, kind, version));
  const r = (await pool.query('select * from pilot_operations where exchange_id=$1 and kind=$2 and version=$3', [e.id, kind, version])).rows[0];
  return { id: r.id, exchangeId: r.exchange_id, kind: r.kind, version: r.version, mode: r.mode, state: r.state, attempts: r.attempts, providerId: r.provider_id, result: r.result, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
}
const payment = (e: Exchange): PaymentFact => ({ sessionId: `cs_${e.id}`, status: 'paid', amount: 6500, currency: 'usd', paymentIntentId: 'pi_fixture', chargeId: 'ch_fixture', transferId: 'tr_fixture', transferred: true, transferReversed: false, transferReversedAmount: 0, refunded: false, refundedAmount: 0, destinationPaymentId: 'py_fixture', checkoutUrl: null });
const shipment = (id: string): Shipment => ({ id, mode: 'test', reference: null, rates: [], selected_rate: null, postage_label: null, tracker: null, to_address: {}, from_address: {}, parcel: {}, refund_status: 'not_submitted' });
let activePayment: PaymentFact; let activeShipment: Shipment; let buys = 0; let refunds = 0; let checkoutCalls = 0;
let uncertainBuy = false; let failRefund = false; let pendingRefund = false; let refundReads = 0; let omitReversal = false; let uncertainCreate = false; let creates = 0;
const fake = {
  stripe: {
    retrieve: async () => structuredClone(activePayment), checkout: async () => { checkoutCalls++; return structuredClone(activePayment); },
    expire: async () => { /* A payment may win the expiry race. */ },
    retrieveRefund: async () => { refundReads++; return { id: 're_fixture', status: activePayment.refunded ? 'succeeded' : 'pending' }; },
    refund: async () => { refunds++; if (failRefund) throw new ProviderFailure(false, 'Refund rejected fixture');
      if (pendingRefund) return { id: 're_fixture', status: 'pending' };
      activePayment.refunded = true; activePayment.refundedAmount = 6500; activePayment.transferReversed = !omitReversal; activePayment.transferred = omitReversal;
      return { id: 're_fixture', status: 'succeeded' }; },
    payout: async () => ({ id: null, status: 'unknown', amount: null }),
  },
  shipping: { retrieve: async () => structuredClone(activeShipment), validateApproved: () => {}, validateInputs: () => ({}),
    config: { taxTreatment: 'Fixture', taxAmount: 0, subsidy: 'Fixture' },
    createShipment: async (id: string) => { creates++; activeShipment = { ...shipment('shp_recovered_fixture'), reference: id }; if (uncertainCreate) throw new ProviderFailure(true, 'create timeout fixture'); return activeShipment; },
    rate: () => ({ id: 'rate_fixture', carrier_account_id: 'ca_fixture', carrier: 'FedEx', service: 'FEDEX_GROUND', rate: '15.00', currency: 'USD', delivery_days: 3 }),
    buy: async () => { buys++; if (uncertainBuy) throw new ProviderFailure(true, 'timeout fixture'); activeShipment.postage_label = { id: 'pl_fixture', label_pdf_url: 'https://example.test/fixture.pdf' }; return structuredClone(activeShipment); },
    refundLabel: async () => ({ refund_status: 'submitted' }),
  }, locations: { find: async () => dropoff },
} as unknown as CommerceProviders;
const worker = () => new CommerceWorker(repository, service, fake);
const command = async (e: Exchange, actor: string, input: unknown) => service.command(actor, e.id, randomUUID(), (await service.get(actor, e.id)).revision, input);

try {
  // Quote creation succeeded remotely before its response was lost. A founder
  // attaches the same provider object; bookkeeping revisions do not break recovery.
  const quoted = await fixture(); uncertainCreate = true;
  const pendingQuote = await command(quoted, A, { type: 'quote' });
  const quoteOp = await queued(quoted, 'quote', pendingQuote.revision);
  await worker().process(quoteOp); const createCount = creates;
  await command(quoted, A, { type: 'attach_provider_reference', operationId: quoteOp.id, providerId: 'shp_recovered_fixture', reason: 'Found exact operation reference in provider fixture' });
  uncertainCreate = false; await worker().process(quoteOp);
  assert.equal(creates, createCount); assert.equal((await service.get(A, quoted.id)).stage, 'offered');
  assert.equal((await service.get(A, quoted.id)).problem, null);
  // A crash after quote publication but before marking the operation done must
  // not publish another version or reset an approval.
  const published = await service.get(A, quoted.id);
  await pool.query("update pilot_operations set state='running' where id=$1", [quoteOp.id]);
  await worker().process(quoteOp); assert.equal((await service.get(A, quoted.id)).offer?.version, published.offer?.version);

  // Crash after payment creation: persisted identity retrieves, it never creates another checkout.
  const paid = await fixture(); activePayment = payment(paid); activeShipment = shipment(currentOffer(paid).quote.shipmentId);
  await mutate(paid, { payment: 'pending', stage: 'awaiting_payment' });
  const checkout = await queued(paid, 'checkout');
  await pool.query("update pilot_operations set provider_id=$2,state='running',attempts=1 where id=$1", [checkout.id, activePayment.sessionId]);
  await worker().process(checkout); assert.equal(checkoutCalls, 0);
  assert.equal((await service.get(A, paid.id)).payment, 'paid');
  // A fresh worker after crash sees the already bought label and only reconciles.
  const label = await queued(paid, 'label');
  activeShipment.postage_label = { id: 'pl_existing', label_pdf_url: 'https://example.test/existing.pdf' };
  await pool.query("update pilot_operations set state='running',attempts=1,result='{\"effectStarted\":true}' where id=$1", [label.id]);
  await worker().process(label); assert.equal(buys, 0); assert.equal((await service.get(A, paid.id)).shipping, 'label_ready');
  // Tracking is monotonic, even when an old canonical response arrives later.
  activeShipment.tracker = { id: 'trk_fixture', status: 'delivered', updated_at: '2026-09-23T12:00:00Z', tracking_code: 'fixture' };
  await worker().applyShipment(paid.id, activeShipment);
  await worker().applyShipment(paid.id, { ...activeShipment, tracker: { ...activeShipment.tracker, status: 'in_transit', updated_at: '2026-09-23T11:00:00Z' } });
  assert.equal((await service.get(A, paid.id)).shipping, 'delivered');

  // Ambiguous label timeout cannot submit a second buy on retry or process restart.
  const failedLabel = await fixture(); activePayment = payment(failedLabel); activeShipment = shipment(currentOffer(failedLabel).quote.shipmentId);
  await mutate(failedLabel, { payment: 'paid', shipping: 'label_pending', stage: 'fulfilling' });
  const uncertain = await queued(failedLabel, 'label'); uncertainBuy = true;
  await worker().process(uncertain); const attemptedBuys = buys;
  await worker().process(uncertain); assert.equal(buys, attemptedBuys);
  assert.equal((await service.get(A, failedLabel.id)).stage, 'needs_attention');
  assert.equal((await service.get(A, failedLabel.id)).payment, 'paid'); uncertainBuy = false;
  // Late canonical label success clears only its operation problem.
  activeShipment.postage_label = { id: 'pl_late', label_pdf_url: 'https://example.test/late.pdf' };
  await worker().process(uncertain); assert.equal(buys, attemptedBuys); assert.equal((await service.get(A, failedLabel.id)).shipping, 'label_ready');
  // The buyer refund is independent of a rejected carrier postage refund.
  await mutate(failedLabel, { payment: 'refunded', transfer: 'reversed', cancellationRequested: true, stage: 'cancelled' });
  activeShipment.refund_status = 'rejected';
  const postageRefund = await queued(failedLabel, 'label_refund'); await worker().process(postageRefund);
  assert.equal((await service.get(A, failedLabel.id)).stage, 'needs_attention');
  await command(failedLabel, A, { type: 'propose_resolution', remedy: 'absorb_postage', reason: 'Founders absorb rejected unused postage refund' });
  for (const actor of [A, B]) await command(failedLabel, actor, { type: 'approve_resolution', binding: (await service.get(actor, failedLabel.id)).resolutionBinding });
  await worker().process(postageRefund);
  assert.equal((await service.get(A, failedLabel.id)).stage, 'cancelled');

  // Payment wins a cancellation race: refund remains visible until canonical reversal.
  const race = await fixture(); activePayment = payment(race); activeShipment = shipment(currentOffer(race).quote.shipmentId);
  await mutate(race, { payment: 'pending', stage: 'awaiting_payment', cancellationRequested: true });
  const racePayment = await queued(race, 'checkout');
  await pool.query('update pilot_operations set provider_id=$2 where id=$1', [racePayment.id, activePayment.sessionId]);
  await worker().process(racePayment); assert.equal((await service.get(A, race.id)).payment, 'refund_pending');
  const refund = await queued(race, 'refund'); failRefund = true;
  await worker().process(refund); assert.equal((await service.get(A, race.id)).payment, 'refund_failed');
  failRefund = false; omitReversal = true;
  await command(race, A, { type: 'retry_operation', operationId: refund.id, reason: 'Provider fixture corrected' });
  await worker().process(refund);
  assert.equal((await service.get(A, race.id)).payment, 'refunded'); assert.notEqual((await service.get(A, race.id)).transfer, 'reversed');
  const refundCount = refunds; activePayment.transferReversed = true; activePayment.transferred = false; omitReversal = false;
  await command(race, A, { type: 'retry_operation', operationId: refund.id, reason: 'Canonical reversal is now available' });
  await worker().process(refund); assert.equal(refunds, refundCount); assert.equal((await service.get(A, race.id)).stage, 'cancelled');
  await worker().applyPayment(racePayment, { ...activePayment, status: 'expired' });
  assert.equal((await service.get(A, race.id)).payment, 'refunded');

  // An asynchronous refund is retrieved by ID after restart, including beyond
  // the creation idempotency window; it must never issue another refund POST.
  const asynchronous = await fixture(); activePayment = payment(asynchronous); pendingRefund = true;
  await mutate(asynchronous, { payment: 'paid', cancellationRequested: true });
  const asynchronousCheckout = await queued(asynchronous, 'checkout');
  await pool.query('update pilot_operations set provider_id=$2 where id=$1', [asynchronousCheckout.id, activePayment.sessionId]);
  const asynchronousRefund = await queued(asynchronous, 'refund');
  await worker().process(asynchronousRefund);
  assert.equal((await service.get(A, asynchronous.id)).payment, 'refund_pending');
  const pendingPostCount = refunds; const pendingReadCount = refundReads;
  await pool.query("update pilot_operations set created_at=now()-interval '2 days' where id=$1", [asynchronousRefund.id]);
  await worker().process(asynchronousRefund);
  assert.equal(refunds, pendingPostCount); assert.ok(refundReads > pendingReadCount);
  activePayment.refunded = true; activePayment.refundedAmount = 6500; activePayment.transferReversed = true; activePayment.transferred = false;
  await worker().process(asynchronousRefund); pendingRefund = false;
  assert.equal(refunds, pendingPostCount); assert.equal((await service.get(A, asynchronous.id)).stage, 'cancelled');

  // A refund after carrier acceptance needs two exact founder decisions.
  await command(paid, A, { type: 'problem', reason: 'Condition differs from approved item' });
  await command(paid, A, { type: 'propose_resolution', remedy: 'refund', reason: 'Both agree to refund without return' });
  let view = await service.get(A, paid.id);
  await assert.rejects(command(paid, B, { type: 'approve_resolution', binding: view.resolutionBinding }), /changed or expired/);
  await command(paid, A, { type: 'approve_resolution', binding: view.resolutionBinding });
  assert.equal((await service.get(A, paid.id)).payment, 'paid');
  view = await service.get(B, paid.id); await command(paid, B, { type: 'approve_resolution', binding: view.resolutionBinding });
  activePayment = payment(paid); activeShipment = shipment(currentOffer(paid).quote.shipmentId);
  await worker().process(await queued(paid, 'refund'));
  assert.equal((await service.get(A, paid.id)).payment, 'refunded');

  // Return authority is separate; changing packed dimensions invalidates it.
  const returning = await fixture(); await mutate(returning, { payment: 'paid', shipping: 'delivered', carrierAcceptedAt: new Date().toISOString() });
  await command(returning, A, { type: 'problem', reason: 'Return requested' });
  await command(returning, A, { type: 'propose_resolution', remedy: 'return', reason: 'Return then original full refund' });
  for (const actor of [A, B]) await command(returning, actor, { type: 'approve_resolution', binding: (await service.get(actor, returning.id)).resolutionBinding });
  await command(returning, A, { type: 'return_packing', packing });
  await repository.transaction(async sql => {
    const e = await repository.get(returning.id, A, sql, true);
    e.returnPlan!.quote = { ...currentOffer(e).quote, shipmentId: 'shp_return_fixture' }; e.returnPlan!.version = 1; e.returnPlan!.subsidy = 'Explicit fixture subsidy';
    await repository.save(sql, e, new Date());
  });
  const staleReturn = (await service.get(A, returning.id)).returnBinding;
  await command(returning, A, { type: 'return_packing', packing: { ...packing, weightOz: 40 } });
  await assert.rejects(command(returning, A, { type: 'approve_return', binding: staleReturn }), /stale/);
  await repository.transaction(async sql => {
    const e = await repository.get(returning.id, A, sql, true); e.returnPlan!.quote = { ...currentOffer(e).quote, shipmentId: 'shp_return_fixture', packingVersion: 2 }; e.returnPlan!.version = 2;
    await repository.save(sql, e, new Date());
  });
  for (const actor of [A, B]) await command(returning, actor, { type: 'approve_return', binding: (await service.get(actor, returning.id)).returnBinding });
  activeShipment = shipment('shp_return_fixture'); activePayment = payment(returning);
  const returnLabel = await queued(returning, 'return_label', 2);
  await worker().process(returnLabel); const returnBuys = buys;
  await worker().process(returnLabel); assert.equal(buys, returnBuys);
  await assert.rejects(command(returning, B, { type: 'return_received' }), /delivery/);
  activeShipment.tracker = { id: 'trk_return', status: 'delivered', updated_at: new Date().toISOString(), tracking_code: 'fixture' };
  await worker().process(returnLabel);
  await assert.rejects(command(returning, A, { type: 'return_received' }), /other participant/);
  await command(returning, B, { type: 'return_received' });
  const returnPayment = await queued(returning, 'checkout');
  await pool.query('update pilot_operations set provider_id=$2 where id=$1', [returnPayment.id, activePayment.sessionId]);
  await worker().process(await queued(returning, 'refund'));
  assert.equal((await service.get(A, returning.id)).stage, 'cancelled');

  // Forgetting leaves no value and blocks the model from silently re-inferring it.
  await service.preference(A, { key: 'worker_fixture', value: 'PRIVATE_PREF', provenance: 'Owner' });
  await service.preference(A, { key: 'worker_fixture', value: null, provenance: 'Forget' });
  await service.preference(A, { key: 'worker_fixture', value: 'PRIVATE_PREF', provenance: 'Model inference' }, true);
  assert(!(await service.preferences(A)).some(p => p.key === 'worker_fixture'));
  const hooks = Fastify();
  hooks.setErrorHandler((error, _request, reply) => { const e = asAppError(error); return reply.status(e.statusCode).send({ error: e.code }); });
  await commerceWebhooks(hooks, repository, { ...providerConfig({}, 'test'), stripeAccount: 'acct_fixture', stripeWebhookSecret: 'fixture-secret', easyPostWebhookSecret: 'fixture-secret', easyPostUser: 'user_fixture' });
  try {
    const eventId = `evt_${randomUUID()}`;
    const event = { id: eventId, type: 'checkout.session.completed', livemode: false,
      data: { object: { id: `cs_${paid.id}`, object: 'checkout.session', metadata: { operation_id: checkout.id } } } };
    const send = (value: unknown, signatureOverride?: string) => {
      const payload = JSON.stringify(value); const timestamp = Math.floor(Date.now()/1000);
      const signature = `t=${timestamp},v1=${createHmac('sha256','fixture-secret').update(`${timestamp}.${payload}`).digest('hex')}`;
      return hooks.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'content-type': 'application/json', 'stripe-signature': signatureOverride ?? signature }, payload });
    };
    const replies = await Promise.all([send(event), send(event)]);
    assert(replies.every(r => r.statusCode === 200));
    assert.equal((await pool.query('select count(*)::int n from pilot_events where provider_key=$1', [`stripe-webhook:test:${eventId}`])).rows[0].n, 1);
    assert.equal((await send(event, 't=1,v1=forged')).statusCode, 401);
    assert.equal((await send({ ...event, livemode: true })).statusCode, 400);
    assert.equal((await send({ ...event, account: 'acct_foreign' })).statusCode, 400);
    assert.equal((await send({ ...event, data: { object: { ...event.data.object, id: 'cs_foreign' } } })).statusCode, 400);
    assert.equal((await service.get(A, paid.id)).payment, 'refunded', 'Webhook prose cannot regress canonical refund');
    const shippingEvent = { id: `evt_${randomUUID()}`, user_id: 'user_fixture', mode: 'test', result: { id: 'trk_return', shipment_id: 'shp_return_fixture' } };
    const payload = JSON.stringify(shippingEvent);
    const headers = { 'content-type': 'application/json', 'x-hmac-signature': 'hmac-sha256-hex=' + createHmac('sha256','fixture-secret').update(payload).digest('hex') };
    for (let i = 0; i < 2; i++) assert.equal((await hooks.inject({ method: 'POST', url: '/webhooks/easypost', headers, payload })).statusCode, 200);
    assert.equal((await pool.query('select count(*)::int n from pilot_events where provider_key=$1', [`easypost-webhook:test:${shippingEvent.id}`])).rows[0].n, 1);
  } finally { await hooks.close(); }
  console.log('PASS: real Postgres quote identity recovery, crash/restart, no duplicate checkout/label, stale tracking, paid-label-failure, payment/cancel race, failed refund, separate reversal, founder decision, return authority/delivery/refund, preference forgetting, duplicate/forged/wrong-account-mode-object webhooks. Providers are deterministic fakes.');
} finally { await pool.end(); }
