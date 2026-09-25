import { z } from 'zod';
import { AppError } from '../errors.js';
import { conflict, currentOffer, digest, offerSettlement, reconciledStage, stableJson, type Exchange, type Operation, type Offer, type Quote } from './domain.js';
import { CommerceRepository } from './repository.js';
import { CommerceService } from './service.js';
import { decimalMinor, EasyPostProvider, ProviderFailure, StripeProvider, type PaymentFact, type Shipment } from './providers.js';
import { FedExLocations } from './locations.js';
import { recoverConnections } from './connections.js';
import { recoverServiceActions } from './service-actions.js';

function operation(row: Record<string, unknown>): Operation {
  return { id: String(row.id), exchangeId: String(row.exchange_id), kind: row.kind as Operation['kind'], version: Number(row.version), mode: row.mode as Operation['mode'],
    state: row.state as Operation['state'], attempts: Number(row.attempts), providerId: row.provider_id as string | null,
    result: row.result as Operation['result'], createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString() };
}
export interface CommerceProviders { stripe: StripeProvider; shipping: EasyPostProvider; locations: FedExLocations }
export class CommerceWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopping = false;
  private active: Promise<void> | undefined;
  constructor(readonly repository: CommerceRepository, readonly service: CommerceService, readonly providers: CommerceProviders,
    private readonly log: (event: { operationId: string; code: string }) => void = () => {}) {}
  start() {
    const loop = () => {
      if (this.stopping) return;
      this.active = this.tick().catch(() => this.log({ operationId: 'worker', code: 'WORKER_CHECK_FAILED' })).finally(() => {
        if (!this.stopping) this.timer = setTimeout(loop, 5_000);
      });
    }; loop();
  }
  async stop() { this.stopping = true; clearTimeout(this.timer); await this.active; }
  async tick() {
    const rows = await this.repository.pool.query(`select * from public.pilot_operations where mode=$1
      and ((state in ('pending','running','uncertain') and attempts<5) or (state='succeeded' and kind in ('checkout','label','payout','label_refund','return_label')))
      and (attempts=0 or updated_at < now()-case when state='succeeded' and kind in ('payout','label_refund') then interval '5 minutes' else interval '30 seconds' end)
      order by updated_at limit 20`, [this.service.mode]);
    for (const row of rows.rows) await this.process(operation(row));
    await this.expireWaiting();
    await this.service.research.inspectPending();
    await recoverConnections(this.service);
    await recoverServiceActions(this.service);
  }
  async process(op: Operation) {
    // Session lock spans the provider call, but no database transaction does.
    // HTTP commands still record cancellation intent; the next operation resolves it.
    const lock = await this.repository.pool.connect();
    const key = `pilot-worker:${op.exchangeId}`;
    try {
      const locked = await lock.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [key]);
      if (!locked.rows[0]?.locked) return;
      const fresh = await lock.query('select * from pilot_operations where id=$1', [op.id]);
      if (!fresh.rows[0]) return;
      op = operation(fresh.rows[0]);
      if (op.state === 'failed') return;
      const row = await lock.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1', [op.exchangeId]);
      const e = row.rows[0]?.data;
      if (!e || e.mode !== this.service.mode) return;
      const reconciling = op.state === 'succeeded';
      if (!reconciling) await lock.query("update pilot_operations set state='running',attempts=attempts+1,updated_at=now() where id=$1", [op.id]);
      else await lock.query('update pilot_operations set updated_at=now() where id=$1', [op.id]);
      if (op.kind === 'quote') await this.quote(op, e);
      else if (op.kind === 'checkout') await this.checkout(op, e);
      else if (op.kind === 'label') await this.label(op, e);
      else if (op.kind === 'cancel_checkout') await this.cancelCheckout(op, e);
      else if (op.kind === 'refund') await this.refund(op, e);
      else if (op.kind === 'label_refund') await this.labelRefund(op, e);
      else if (op.kind === 'payout') await this.payout(op, e);
      else if (op.kind === 'return_quote') await this.returnQuote(op, e);
      else if (op.kind === 'return_label') await this.returnLabel(op, e);
    } catch (error) {
      if (op.kind === 'quote' || op.kind === 'return_quote') {
        const latest = await this.repository.pool.query('select id from pilot_operations where exchange_id=$1 and kind=$2 order by created_at desc limit 1', [op.exchangeId, op.kind]);
        const current = await this.repository.pool.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1', [op.exchangeId]);
        if (latest.rows[0]?.id !== op.id || ['cancelled','expired'].includes(current.rows[0]?.data.stage ?? '')) {
          await this.done(op, op.providerId, { superseded: true }); return;
        }
      }
      const uncertain = error instanceof ProviderFailure && error.uncertain;
      const exhausted = op.attempts >= 4;
      // Don't demote a successful financial operation due to a polling outage.
      if (op.state !== 'succeeded') await this.repository.pool.query(`update pilot_operations set state=$2,updated_at=now() where id=$1`,
        [op.id, uncertain && !exhausted ? 'uncertain' : 'failed']);
      await this.repository.transaction(async sql => {
        const r = await sql.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1 for update', [op.exchangeId]);
        const e = r.rows[0]?.data; if (!e) return;
        e.operationIssues ??= {};
        e.operationIssues[op.id] = error instanceof AppError ? error.message : error instanceof ProviderFailure ? error.reason : 'Provider action failed. A founder must review the operation.';
        e.stage = 'needs_attention';
        if (op.kind === 'refund' && e.payment !== 'refunded') e.payment = uncertain ? 'refund_pending' : 'refund_failed';
        await this.repository.save(sql, e, new Date());
        await this.repository.event(sql, e, null, 'operation_attention', { operationId: op.id, kind: op.kind, uncertain, exhausted });
      });
      this.log({ operationId: op.id, code: uncertain ? 'PROVIDER_UNCERTAIN' : 'PROVIDER_ACTION_FAILED' });
    } finally {
      await lock.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]); lock.release();
    }
  }
  async done(op: Operation, providerId: string | null, result: unknown) {
    await this.repository.transaction(async sql => {
      await sql.query("update pilot_operations set state='succeeded',provider_id=$2,result=$3,updated_at=now() where id=$1", [op.id, providerId, result]);
      const row = await sql.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1 for update', [op.exchangeId]);
      const e = row.rows[0]?.data;
      if (e?.operationIssues?.[op.id]) {
        delete e.operationIssues[op.id]; reconciledStage(e);
        await this.repository.save(sql, e, new Date());
      }
    });
  }
  private async quote(op: Operation, e: Exchange) {
    const published = e.offers.find(o => o.quote.shipmentId === op.providerId);
    if (published) { await this.done(op, op.providerId, { offerVersion: published.version }); return; }
    if (e.cancellationRequested || e.payment !== 'unpaid') { await this.done(op, op.providerId, { superseded: true }); return; }
    const buyer = await this.repository.privateInput(e, e.buyerId);
    const seller = await this.repository.privateInput(e, e.sellerId);
    await this.quoteInputs(op, e, { item: e.item, buyer: buyer.addressVersion, seller: seller.addressVersion, packing: seller.packingVersion });
    if (!seller.packing || !seller.address) conflict('Shipping inputs are incomplete.');
    const config = this.providers.shipping.config;
    if (!config.taxTreatment || !config.subsidy) throw new AppError('PROVIDER_NOT_READY', 'The operator must confirm tax treatment and processing subsidy.');
    if (!op.providerId && op.result?.effectStarted) throw new ProviderFailure(true, 'Shipment creation outcome is unknown. Reconcile by the persisted operation reference; do not create another shipment.');
    if (!op.providerId) await this.effectStarted(op);
    const shipment = op.providerId ? await this.providers.shipping.retrieve(op.providerId) : await this.providers.shipping.createShipment(op.id, buyer, seller);
    if (shipment.reference !== op.id) conflict('Shipment reference does not match this operation.');
    await this.repository.pool.query('update pilot_operations set provider_id=$2 where id=$1', [op.id, shipment.id]);
    const corrections = this.providers.shipping.validateInputs(shipment, buyer, seller);
    if (corrections.buyer || corrections.seller) {
      await this.repository.transaction(async sql => {
        const current = await this.repository.get(e.id, e.buyerId, sql, true);
        if (current.revision !== e.revision) return;
        for (const [actor, address] of [[e.buyerId, corrections.buyer], [e.sellerId, corrections.seller]] as const) if (address) {
          const input = await this.repository.privateInput(current, actor, sql);
          input.suggestedAddress = address; await this.repository.savePrivate(sql, current, actor, input);
        }
      });
      conflict('The provider suggests an address correction. Each affected owner must confirm it in their private shipping form, then request a fresh offer.');
    }
    const rate = this.providers.shipping.rate(shipment);
    const dropoff = await this.providers.locations.find(seller.address.zip, seller.packing);
    const quote: Quote = { shipmentId: shipment.id, rateId: rate.id, carrierAccountId: rate.carrier_account_id,
      carrier: rate.carrier, service: rate.service, shippingAmount: decimalMinor(rate.rate), currency: 'USD',
      expiresAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), estimatedDays: rate.delivery_days ?? null,
      originVersion: seller.addressVersion, destinationVersion: buyer.addressVersion, packingVersion: seller.packingVersion,
      artifact: 'pdf', dropoff };
    await this.service.publishQuote(e.id, e.revision, quote, { postageFunding: 'platform', taxAmount: config.taxAmount, feeAmount: 0, taxTreatment: config.taxTreatment, subsidy: config.subsidy });
    await this.done(op, shipment.id, { offerVersion: e.offers.length + 1 });
  }
  private requirePlatformShipping(offer: Offer) {
    // The existing EasyPost adapter charges the PLATFORM. Never reimburse a
    // seller and then silently use that adapter to pay the same postage again.
    if (offerSettlement(offer).postageFunding !== 'platform') {
      throw new AppError('PROVIDER_NOT_READY', 'Seller-funded postage requires the connected shipping execution path before checkout or fulfillment.');
    }
  }
  private async checkout(op: Operation, e: Exchange) {
    if (op.result?.cancelledBeforeCreation === true) return;
    const offer = e.offers.find(o => o.version === op.version);
    if (!offer) conflict('Missing offer version.');
    let fact: PaymentFact;
    if (op.providerId) fact = await this.providers.stripe.retrieve(op.providerId, e, offer, op.id);
    else {
      if (Date.now() - Date.parse(op.createdAt) > 23 * 3_600_000) throw new ProviderFailure(true, 'Stripe idempotency window elapsed. Manual reconciliation is required.');
      if (e.cancellationRequested && op.attempts === 0) {
        await this.cancelUnpaid(e); await this.done(op, null, { cancelledBeforeCreation: true }); return;
      }
      if (e.approvals.length !== 2 || e.approvals.some(a => a.digest !== digest(offer))) conflict('Checkout approvals are invalid.');
      this.requirePlatformShipping(offer);
      const shipment = await this.providers.shipping.retrieve(offer.quote.shipmentId);
      this.providers.shipping.validateApproved(shipment, offer.quote);
      fact = await this.providers.stripe.checkout(e, offer, op.id);
    }
    await this.applyPayment(op, fact);
    await this.done(op, fact.sessionId, fact);
  }
  async applyPayment(op: Operation, fact: PaymentFact) {
    await this.repository.transaction(async sql => {
      const row = await sql.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1 for update', [op.exchangeId]);
      const e = row.rows[0]!.data;
      const before = stableJson(e);
      if (fact.status === 'paid') {
        e.transfer = fact.transferred ? 'transferred' : e.transfer;
        if (fact.transferReversed) e.transfer = 'reversed';
        else if (fact.transferReversedAmount > 0) e.transfer = 'partially_reversed';
        if (fact.refunded) {
          e.payment = 'refunded';
          e.operationIssues ??= {};
          if (!fact.transferReversed) e.operationIssues.settlement = 'Buyer refund confirmed; seller transfer reversal still needs reconciliation.';
          else delete e.operationIssues.settlement;
          reconciledStage(e);
        }
        else if (e.payment === 'refunded') { /* A terminal refund cannot regress. */ }
        else if (fact.refundedAmount > 0 || fact.transferReversedAmount > 0 || fact.transferReversed || e.payment === 'partially_refunded') {
          if (fact.refundedAmount > 0) e.payment = 'partially_refunded';
          e.operationIssues ??= {};
          e.operationIssues.settlement = 'Partial refund or seller reversal requires provider reconciliation by a founder before fulfillment.';
        }
        else if (e.cancellationRequested || ['cancelled','expired'].includes(e.stage)) {
          e.payment = 'refund_pending'; e.stage = 'needs_attention';
          await this.repository.enqueue(sql, e, 'refund', op.version);
        } else if (!['refund_pending','refund_failed'].includes(e.payment)) {
          e.payment = 'paid';
          if (e.shipping === 'none') { e.shipping = 'label_pending'; e.stage = 'fulfilling'; await this.repository.enqueue(sql, e, 'label', op.version); }
        }
        if (fact.transferred && !fact.refunded) await this.repository.enqueue(sql, e, 'payout', op.version);
        await sql.query('update pilot_items set sold=true where reserved_by=$1', [e.id]);
      } else if (fact.status === 'expired' && !['paid','refunded','refund_pending','refund_failed','partially_refunded'].includes(e.payment)) {
        e.payment = 'failed'; e.stage = e.cancellationRequested ? 'cancelled' : 'expired';
        await sql.query('update pilot_items set reserved_by=null,reserved_until=null where reserved_by=$1 and sold=false', [e.id]);
      }
      reconciledStage(e);
      if (stableJson(e) !== before) { await this.repository.save(sql, e, new Date()); await this.repository.notifyStatus(sql, e); }
      await this.repository.event(sql, e, null, 'payment_reconciled', { sessionId: fact.sessionId, payment: e.payment, transferId: fact.transferId, chargeId: fact.chargeId },
        `stripe:${e.mode}:${fact.sessionId}:${e.payment}:${e.transfer}`);
    });
  }
  private async label(op: Operation, e: Exchange) {
    const offer = e.offers.find(o => o.version === op.version);
    if (!offer) conflict('Missing offer.');
    this.requirePlatformShipping(offer);
    let shipment = await this.providers.shipping.retrieve(offer.quote.shipmentId);
    this.providers.shipping.validateApproved(shipment, offer.quote);
    if (!shipment.postage_label) {
      if (e.payment === 'refunded') { await this.done(op, shipment.id, { cancelledNoLabel: true }); return; }
      if (op.result?.effectStarted) throw new ProviderFailure(true, 'Label purchase outcome remains uncertain. Never submit a second buy automatically.');
      if (e.cancellationRequested || e.payment !== 'paid') conflict('Postage requires confirmed payment without cancellation.');
      if (e.problem || Object.keys(e.operationIssues ?? {}).some(id => id !== op.id)) conflict('Resolve the outstanding order problem before purchasing postage.');
      if (Date.parse(offer.expiresAt) <= Date.now() || e.approvals.length !== 2 || e.approvals.some(a => a.digest !== digest(offer))) conflict('Postage authority expired or changed. Resolve or refund the paid order.');
      await this.effectStarted(op);
      shipment = await this.providers.shipping.buy(offer.quote);
    }
    if (!shipment.postage_label?.label_pdf_url) throw new ProviderFailure(true, 'Paid label has no usable PDF yet.');
    await this.applyShipment(e.id, shipment);
    await this.done(op, shipment.id, { labelId: shipment.postage_label.id, trackerId: shipment.tracker?.id ?? null });
  }
  async applyShipment(id: string, shipment: Shipment) {
    await this.repository.transaction(async sql => {
      const row = await sql.query<{ data: Exchange }>('select data from pilot_exchanges where id=$1 for update', [id]);
      const e = row.rows[0]!.data;
      const before = stableJson(e);
      this.requirePlatformShipping(currentOffer(e));
      this.providers.shipping.validateApproved(shipment, currentOffer(e).quote);
      if (!shipment.postage_label) return;
      if (e.payment === 'refunded' && !e.sellerDroppedAt && !e.carrierAcceptedAt && !['in_transit','delivered','exception'].includes(e.shipping)) {
        await this.repository.enqueue(sql, e, 'label_refund', currentOffer(e).version);
      }
      if (e.shipping === 'none' || e.shipping === 'label_pending') e.shipping = 'label_ready';
      const status = shipment.tracker?.status;
      const updatedAt = shipment.tracker?.updated_at;
      if (updatedAt && e.trackingUpdatedAt && Date.parse(updatedAt) < Date.parse(e.trackingUpdatedAt)) return;
      if (updatedAt) e.trackingUpdatedAt = updatedAt;
      if (['in_transit','out_for_delivery','available_for_pickup','delivered'].includes(status ?? '') && !e.carrierAcceptedAt) {
        e.carrierAcceptedAt = updatedAt ?? new Date().toISOString();
      }
      if (status === 'delivered') e.shipping = 'delivered';
      else if (e.shipping !== 'delivered' && ['in_transit','out_for_delivery','available_for_pickup'].includes(status ?? '')) e.shipping = 'in_transit';
      else if (e.shipping !== 'delivered' && ['failure','error','return_to_sender','cancelled'].includes(status ?? '')) {
        e.shipping = 'exception'; e.stage = 'needs_attention'; e.problem = 'Carrier exception requires a founder decision.';
      }
      reconciledStage(e);
      if (stableJson(e) !== before) { await this.repository.save(sql, e, new Date()); await this.repository.notifyStatus(sql, e); }
      await this.repository.event(sql, e, null, 'tracking_reconciled', { shipmentId: shipment.id, trackerId: shipment.tracker?.id, status: e.shipping, providerUpdatedAt: shipment.tracker?.updated_at },
        `easypost:${e.mode}:${shipment.id}:${shipment.tracker?.updated_at ?? 'label'}:${e.shipping}`);
    });
  }
  private async cancelUnpaid(e: Exchange) {
    await this.repository.transaction(async sql => {
      const current = await this.repository.get(e.id, e.buyerId, sql, true);
      if (['paid','refund_pending','refunded'].includes(current.payment)) return;
      current.stage = 'cancelled'; current.payment = 'failed';
      await this.repository.save(sql, current, new Date());
      await sql.query('update pilot_items set reserved_by=null,reserved_until=null where reserved_by=$1 and sold=false', [e.id]);
    });
  }
  private async paymentOperation(e: Exchange) {
    const r = await this.repository.pool.query("select * from pilot_operations where exchange_id=$1 and kind='checkout' order by version desc limit 1", [e.id]);
    if (!r.rows[0]) conflict('Payment operation is missing.');
    return operation(r.rows[0]);
  }
  private async cancelCheckout(op: Operation, e: Exchange) {
    const payment = await this.paymentOperation(e);
    if (payment.result?.cancelledBeforeCreation === true) { await this.done(op, null, { status: 'cancelled_before_creation' }); return; }
    if (!payment.providerId) throw new ProviderFailure(true, 'Checkout creation must reconcile before cancellation.');
    let fact = await this.providers.stripe.retrieve(payment.providerId, e, currentOffer(e), payment.id);
    if (fact.status === 'open') {
      try { await this.providers.stripe.expire(payment.providerId, op.id); } catch { /* Race: retrieve canonical state below. */ }
      fact = await this.providers.stripe.retrieve(payment.providerId, e, currentOffer(e), payment.id);
    }
    await this.applyPayment(payment, fact);
    if (fact.status === 'open' || fact.status === 'unpaid') throw new ProviderFailure(true, 'Checkout remains unresolved.');
    await this.done(op, fact.sessionId, { status: fact.status });
  }
  private async refund(op: Operation, e: Exchange) {
    const approvedRefund = e.resolution?.approvedBy.length === 2 && e.resolution.offerDigest === digest(currentOffer(e))
      && (e.resolution.remedy === 'refund' || (e.resolution.remedy === 'return' && e.returnPlan?.resolutionId === e.resolution.id && !!e.returnPlan.receivedAt && e.returnPlan.shipping === 'delivered'));
    if (!approvedRefund && (e.sellerDroppedAt || e.carrierAcceptedAt || ['in_transit','delivered','exception'].includes(e.shipping))) conflict('After handoff a founder decision is required before refund.');
    const payment = await this.paymentOperation(e);
    if (!payment.providerId) throw new ProviderFailure(true, 'Payment identity must be reconciled first.');
    let fact = await this.providers.stripe.retrieve(payment.providerId, e, currentOffer(e), payment.id);
    if (!fact.paymentIntentId || fact.status !== 'paid') conflict('There is no confirmed payment to refund.');
    if (!fact.refunded && fact.refundedAmount > 0) conflict('A partial provider refund needs manual reconciliation before another refund.');
    if (fact.transferReversedAmount > 0 && !fact.transferReversed) conflict('A partial seller reversal needs manual provider reconciliation before refunding.');
    if (Date.now() - Date.parse(op.createdAt) > 23 * 3_600_000 && !op.providerId && !fact.refunded) throw new ProviderFailure(true, 'Refund idempotency window elapsed. Manual provider reconciliation required.');
    const reverseTransfer = typeof op.result?.reverseTransfer === 'boolean' ? op.result.reverseTransfer : !fact.transferReversed;
    await this.repository.pool.query("update pilot_operations set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('reverseTransfer',$2::boolean) where id=$1", [op.id, reverseTransfer]);
    let result = fact.refunded ? { id: op.providerId ?? 'provider-confirmed', status: 'succeeded' }
      : op.providerId ? await this.providers.stripe.retrieveRefund(op.providerId, fact.paymentIntentId, fact.amount)
        : await this.providers.stripe.refund(fact.paymentIntentId, fact.amount, op.id, reverseTransfer);
    await this.repository.pool.query('update pilot_operations set provider_id=$2 where id=$1', [op.id, result.id]);
    if (!fact.refunded && result.status === 'pending') result = await this.providers.stripe.retrieveRefund(result.id, fact.paymentIntentId, fact.amount);
    if (result.status !== 'succeeded') throw new ProviderFailure(!['failed','canceled'].includes(result.status), 'Refund is pending or failed; funds are not yet refunded.');
    fact = await this.providers.stripe.retrieve(payment.providerId, e, currentOffer(e), payment.id);
    await this.applyPayment(payment, fact);
    if (!fact.refunded || !fact.transferReversed) throw new ProviderFailure(true, 'Buyer refund and seller transfer reversal are not both confirmed yet.');
    await this.repository.transaction(async sql => {
      const current = await this.repository.get(e.id, e.buyerId, sql, true);
      current.payment = 'refunded'; current.transfer = 'reversed';
      current.problem = null;
      if (current.shipping === 'label_ready' && !current.sellerDroppedAt && !current.carrierAcceptedAt) await this.repository.enqueue(sql, current, 'label_refund', op.version);
      reconciledStage(current);
      await this.repository.save(sql, current, new Date());
      await this.repository.event(sql, current, null, 'refund_confirmed', { refundId: result.id, paymentIntentId: fact.paymentIntentId, amount: fact.amount });
    });
    await this.done(op, result.id, { status: result.status });
  }
  private async labelRefund(op: Operation, e: Exchange) {
    if (op.result?.costAccepted === true) return;
    this.requirePlatformShipping(currentOffer(e));
    const id = currentOffer(e).quote.shipmentId;
    const shipment = await this.providers.shipping.retrieve(id);
    let status = shipment.refund_status;
    if (!status || status === 'not_submitted') {
      if (op.result?.effectStarted) throw new ProviderFailure(true, 'Unused-label refund outcome is uncertain. Check the same shipment; do not submit another refund.');
      await this.effectStarted(op);
      const result = await this.providers.shipping.refundLabel(id);
      status = z.string().parse(result.refund_status);
    }
    if (status === 'rejected') {
      await this.repository.pool.query("update pilot_operations set result=coalesce(result,'{}'::jsonb)||'{\"refundStatus\":\"rejected\"}'::jsonb where id=$1", [op.id]);
      conflict('The carrier rejected the unused-label refund. Both founders can record acceptance of the postage cost separately from the buyer refund.');
    }
    await this.done(op, id, { refundStatus: status });
  }
  private async payout(op: Operation, e: Exchange) {
    const payment = await this.paymentOperation(e);
    if (!payment.providerId) throw new ProviderFailure(true, 'Payment identity must reconcile before payout.');
    const fact = await this.providers.stripe.retrieve(payment.providerId, e, currentOffer(e), payment.id);
    const payout = await this.providers.stripe.payout(e.sellerId, fact, op.providerId);
    if (payout.amount !== null && payout.amount !== offerSettlement(currentOffer(e)).sellerTransferAmount) conflict('Payout contribution does not match the approved item and postage settlement.');
    await this.repository.transaction(async sql => {
      const current = await this.repository.get(e.id, e.sellerId, sql, true);
      if (payout.status !== 'unknown' && current.payout !== payout.status) {
        current.payout = payout.status;
        await this.repository.save(sql, current, new Date());
        await this.repository.event(sql, current, null, 'payout_reconciled', payout, `stripe-payout:${e.mode}:${payout.id}:${payout.status}`);
      }
    });
    if (payout.status === 'failed') conflict('Stripe reports a failed bank payout. Seller must resolve bank details in Stripe.');
    await this.done(op, payout.id, payout);
  }
  private async effectStarted(op: Operation) {
    await this.repository.pool.query("update pilot_operations set result=coalesce(result,'{}'::jsonb)||'{\"effectStarted\":true}'::jsonb where id=$1", [op.id]);
  }
  private async returnQuote(op: Operation, e: Exchange) {
    const plan = e.returnPlan;
    if (plan?.quote?.shipmentId === op.providerId) { await this.done(op, op.providerId, { returnVersion: plan.version }); return; }
    if (!plan || plan.shipping !== 'none') conflict('Return inputs changed. Request a fresh quote.');
    const destination = await this.repository.privateInput(e, e.sellerId);
    const origin = await this.repository.privateInput(e, e.buyerId);
    await this.quoteInputs(op, e, { resolutionId: plan.resolutionId, destination: destination.addressVersion, origin: origin.addressVersion, packing: origin.returnPackingVersion });
    if (!origin.address || !destination.address || !origin.returnPacking?.canPrint) conflict('Return packing and original addresses are required.');
    const sender = { ...origin, packing: origin.returnPacking, packingVersion: origin.returnPackingVersion ?? 0 };
    if (!op.providerId && op.result?.effectStarted) throw new ProviderFailure(true, 'Return shipment creation is uncertain. Reconcile its operation reference before proceeding.');
    if (!op.providerId) await this.effectStarted(op);
    const shipment = op.providerId ? await this.providers.shipping.retrieve(op.providerId) : await this.providers.shipping.createShipment(op.id, destination, sender);
    if (shipment.reference !== op.id) conflict('Return shipment reference does not match.');
    await this.repository.pool.query('update pilot_operations set provider_id=$2 where id=$1', [op.id, shipment.id]);
    const corrections = this.providers.shipping.validateInputs(shipment, destination, sender);
    if (corrections.buyer || corrections.seller) conflict('Return address verification changed. Resolve the address with both founders before buying return postage.');
    const rate = this.providers.shipping.rate(shipment);
    const dropoff = await this.providers.locations.find(origin.address.zip, sender.packing);
    const quote: Quote = { shipmentId: shipment.id, rateId: rate.id, carrierAccountId: rate.carrier_account_id,
      carrier: rate.carrier, service: rate.service, shippingAmount: decimalMinor(rate.rate), currency: 'USD',
      expiresAt: new Date(Date.now() + 2 * 3600000).toISOString(), estimatedDays: rate.delivery_days ?? null,
      originVersion: origin.addressVersion, destinationVersion: destination.addressVersion, packingVersion: sender.packingVersion, artifact: 'pdf', dropoff };
    await this.repository.transaction(async sql => {
      const current = await this.repository.get(e.id, e.buyerId, sql, true);
      if (current.revision !== e.revision || !current.returnPlan || current.returnPlan.resolutionId !== plan.resolutionId) conflict('Return inputs changed while quoting.');
      current.returnPlan.quote = quote; current.returnPlan.version++; current.returnPlan.approvals = [];
      const oldQuotes = await sql.query("select id from pilot_operations where exchange_id=$1 and kind='return_quote'", [e.id]);
      for (const row of oldQuotes.rows) if (current.operationIssues) delete current.operationIssues[row.id];
      current.returnPlan.subsidy = 'The founders approve the platform paying this additional return postage; no extra buyer charge. Full original buyer payment is refunded after carrier delivery and seller receipt.';
      await this.repository.save(sql, current, new Date());
      for (const actor of [e.buyerId, e.sellerId]) await this.repository.message(sql, current, e.buyerId, actor, 'offer', { action: 'return_quote', version: current.returnPlan.version, amount: quote.shippingAmount });
    });
    await this.done(op, shipment.id, { returnVersion: plan.version + 1 });
  }
  private async quoteInputs(op: Operation, e: Exchange, inputs: unknown) {
    const latest = await this.repository.pool.query('select id from pilot_operations where exchange_id=$1 and kind=$2 order by created_at desc limit 1', [e.id, op.kind]);
    if (latest.rows[0]?.id !== op.id) conflict('A newer quote request supersedes this operation.');
    const hash = digest(inputs);
    if (op.result?.inputHash ? op.result.inputHash !== hash : e.revision !== op.version) conflict('The quote inputs changed. Request a fresh quote.');
    await this.repository.pool.query("update pilot_operations set result=coalesce(result,'{}'::jsonb)||jsonb_build_object('inputHash',$2::text) where id=$1", [op.id, hash]);
  }
  private async returnLabel(op: Operation, e: Exchange) {
    const plan = e.returnPlan;
    if (!plan?.quote || plan.version !== op.version || plan.resolutionId !== e.resolution?.id || plan.approvals.length !== 2) conflict('Return postage approvals changed.');
    let shipment = await this.providers.shipping.retrieve(plan.quote.shipmentId);
    this.providers.shipping.validateApproved(shipment, plan.quote);
    if (!shipment.postage_label) {
      if (op.result?.effectStarted) throw new ProviderFailure(true, 'Return label purchase is uncertain. Do not buy another label.');
      if (Date.parse(plan.quote.expiresAt) <= Date.now() || e.payment !== 'paid') conflict('Return postage authority expired or payment changed.');
      await this.effectStarted(op);
      shipment = await this.providers.shipping.buy(plan.quote);
    }
    if (!shipment.postage_label?.label_pdf_url) throw new ProviderFailure(true, 'The return label does not have a usable PDF yet.');
    await this.repository.transaction(async sql => {
      const current = await this.repository.get(e.id, e.buyerId, sql, true);
      const next = current.returnPlan;
      if (!next?.quote || next.quote.shipmentId !== shipment.id) conflict('Return shipment changed.');
      const before = stableJson(next);
      if (next.shipping === 'label_pending') next.shipping = 'label_ready';
      const tracker = shipment.tracker;
      if (tracker && (!next.trackingUpdatedAt || Date.parse(tracker.updated_at) >= Date.parse(next.trackingUpdatedAt))) {
        next.trackingUpdatedAt = tracker.updated_at;
        if (['in_transit','out_for_delivery','available_for_pickup','delivered'].includes(tracker.status)) {
          next.carrierAcceptedAt ??= tracker.updated_at;
          if (next.shipping !== 'delivered') next.shipping = tracker.status === 'delivered' ? 'delivered' : 'in_transit';
        } else if (next.shipping !== 'delivered' && ['failure','error','return_to_sender','cancelled'].includes(tracker.status)) next.shipping = 'exception';
      }
      if (stableJson(next) !== before) {
        await this.repository.save(sql, current, new Date());
        await this.repository.event(sql, current, null, 'return_tracking_reconciled', { shipmentId: shipment.id, status: next.shipping }, `return:${e.mode}:${shipment.id}:${next.trackingUpdatedAt ?? 'label'}:${next.shipping}`);
        for (const actor of [e.buyerId, e.sellerId]) await this.repository.message(sql, current, e.buyerId, actor, 'status', { action: 'provider_update', text: `Return shipping: ${next.shipping}. Refund requires delivered return and seller receipt confirmation.` });
      }
    });
    await this.done(op, shipment.id, { labelId: shipment.postage_label.id, trackerId: shipment.tracker?.id ?? null });
  }
  private async expireWaiting() {
    const rows = await this.repository.pool.query<{ data: Exchange }>(`select data from pilot_exchanges where mode=$1
      and data->>'payment'='unpaid' and data->>'stage' in ('draft','waiting_for_seller','preparing_offer','offered')
      and (data->>'expiresAt')::timestamptz < now() limit 20`, [this.service.mode]);
    for (const { data } of rows.rows) await this.repository.transaction(async sql => {
      const e = await this.repository.get(data.id, data.buyerId, sql, true);
      if (e.payment !== 'unpaid') return;
      e.stage = 'expired'; e.approvals = [];
      await this.repository.save(sql, e, new Date());
      await this.repository.event(sql, e, null, 'request_expired', {});
    });
  }
}
