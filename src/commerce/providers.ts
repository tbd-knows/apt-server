import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { addressSchema, conflict, type Exchange, type Mode, type Offer, type PrivateInput, type Quote } from './domain.js';

export interface ProviderConfig {
  mode: Mode; stripeKey: string; stripeAccount: string; stripeWebhookSecret: string;
  connectedAccounts: Record<string, string>; publicUrl: string;
  easyPostKey: string; easyPostUser: string; easyPostWebhookSecret: string;
  carrierAccount: string; carrier: string; service: string;
  fedexKey: string; fedexSecret: string;
  taxAmount: number; taxTreatment: string; subsidy: string;
}
export function providerConfig(env: NodeJS.ProcessEnv, mode: Mode): ProviderConfig {
  let connectedAccounts: Record<string, string> = {};
  if (env.STRIPE_CONNECTED_ACCOUNTS) connectedAccounts = z.record(z.uuid(), z.string().regex(/^acct_[A-Za-z0-9]+$/)).parse(JSON.parse(env.STRIPE_CONNECTED_ACCOUNTS));
  const publicUrl = env.APT_PUBLIC_URL ?? '';
  if (publicUrl && (!URL.canParse(publicUrl) || new URL(publicUrl).protocol !== 'https:' || new URL(publicUrl).origin !== publicUrl)) throw new Error('APT_PUBLIC_URL must be an HTTPS origin.');
  const stripeKey = env.STRIPE_SECRET_KEY ?? '';
  if (stripeKey && !stripeKey.startsWith(mode === 'live' ? 'sk_live_' : 'sk_test_')) throw new Error('Stripe key does not match commerce mode.');
  return {
    mode, stripeKey, stripeAccount: env.STRIPE_PLATFORM_ACCOUNT_ID ?? '', stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? '',
    connectedAccounts, publicUrl, easyPostKey: env.EASYPOST_API_KEY ?? '', easyPostUser: env.EASYPOST_USER_ID ?? '',
    easyPostWebhookSecret: env.EASYPOST_WEBHOOK_SECRET ?? '', carrierAccount: env.EASYPOST_CARRIER_ACCOUNT_ID ?? '',
    carrier: env.APT_SHIPPING_CARRIER ?? 'FedEx', service: env.APT_SHIPPING_SERVICE ?? 'FEDEX_GROUND',
    fedexKey: env.FEDEX_CLIENT_ID ?? '', fedexSecret: env.FEDEX_CLIENT_SECRET ?? '',
    taxAmount: z.coerce.number().int().min(0).max(1_000_000).parse(env.APT_PILOT_TAX_MINOR ?? '0'),
    taxTreatment: env.APT_PILOT_TAX_TREATMENT ?? '', subsidy: env.APT_PILOT_FEE_SUBSIDY ?? '',
  };
}
export class ProviderFailure extends Error {
  constructor(readonly uncertain: boolean, readonly reason: string) { super(reason); }
}
function configured(...values: string[]) {
  if (values.some(v => !v || v.includes('replace_'))) throw new AppError('PROVIDER_NOT_READY', 'Provider setup is incomplete. Check the pilot setup checklist.');
}
const object = z.record(z.string(), z.unknown());
async function providerRequest(url: string, init: RequestInit, fetcher: typeof fetch) {
  let response: Response;
  try { response = await fetcher(url, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error' }); }
  catch { throw new ProviderFailure(true, 'Provider response was not received; reconciliation required.'); }
  if (!response.ok) throw new ProviderFailure(response.status >= 500 || response.status === 429 || response.status === 408,
    `Provider rejected the request (${response.status}).`);
  try { return object.parse(await response.json()); }
  catch { throw new ProviderFailure(true, 'Provider response could not be verified.'); }
}
export interface PaymentFact {
  sessionId: string; status: 'open' | 'expired' | 'paid' | 'unpaid'; amount: number; currency: string;
  paymentIntentId: string | null; chargeId: string | null; transferId: string | null;
  transferred: boolean; transferReversed: boolean; transferReversedAmount: number; refunded: boolean; refundedAmount: number;
  destinationPaymentId: string | null; checkoutUrl: string | null;
}
const sessionSchema = z.object({
  id: z.string(), livemode: z.boolean(), client_reference_id: z.string(), amount_total: z.number().int(), currency: z.string(),
  payment_status: z.string(), status: z.string(), payment_intent: z.union([z.string(), object]).nullable(), url: z.string().nullable(),
  metadata: z.object({ exchange_id: z.string(), version: z.string(), operation_id: z.string() }),
});
export class StripeProvider {
  constructor(readonly config: ProviderConfig, private readonly fetcher: typeof fetch = fetch) {}
  async call(path: string, fields?: Record<string, string>, operationId?: string, account?: string) {
    configured(this.config.stripeKey, this.config.stripeAccount);
    return providerRequest(`https://api.stripe.com/v1/${path}`, {
      method: fields ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.config.stripeKey}`, 'Stripe-Version': '2025-02-24.acacia',
        ...(fields ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(operationId ? { 'Idempotency-Key': operationId } : {}), ...(account ? { 'Stripe-Account': account } : {}),
      }, ...(fields ? { body: new URLSearchParams(fields) } : {}),
    }, this.fetcher);
  }
  async accountReady(sellerId: string) {
    const accountId = this.config.connectedAccounts[sellerId] ?? '';
    configured(accountId);
    const platform = await this.call('account');
    if (platform.id !== this.config.stripeAccount) conflict('Stripe platform account does not match configuration.');
    const account = await this.call(`accounts/${encodeURIComponent(accountId)}`);
    const capabilities = object.parse(account.capabilities);
    if (account.charges_enabled !== true || capabilities.transfers !== 'active') conflict('Seller must finish Stripe onboarding before checkout.');
    return accountId;
  }
  async onboarding(sellerId: string, operationId: string) {
    const account = this.config.connectedAccounts[sellerId] ?? '';
    configured(account, this.config.publicUrl);
    return this.call('account_links', { account, type: 'account_onboarding',
      refresh_url: `${this.config.publicUrl}/commerce/return`, return_url: `${this.config.publicUrl}/commerce/return` }, operationId);
  }
  async checkout(exchange: Exchange, offer: Offer, operationId: string) {
    configured(this.config.publicUrl, this.config.taxTreatment, this.config.subsidy);
    const destination = await this.accountReady(exchange.sellerId);
    const response = await this.call('checkout/sessions', {
      mode: 'payment', 'payment_method_types[0]': 'card', client_reference_id: exchange.id,
      'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(offer.buyerTotal),
      'line_items[0][price_data][product_data][name]': `TBD approved offer ${offer.version}`, 'line_items[0][quantity]': '1',
      'payment_intent_data[transfer_data][destination]': destination,
      'payment_intent_data[transfer_data][amount]': String(offer.item.sellerAmount),
      'payment_intent_data[metadata][exchange_id]': exchange.id,
      'metadata[exchange_id]': exchange.id, 'metadata[version]': String(offer.version), 'metadata[operation_id]': operationId,
      expires_at: String(Math.floor(Math.min(Date.parse(offer.expiresAt), Date.now() + 23 * 3_600_000) / 1000)),
      success_url: `${this.config.publicUrl}/commerce/return`, cancel_url: `${this.config.publicUrl}/commerce/return`,
    }, operationId);
    return this.paymentFact(response, exchange, offer, operationId);
  }
  async retrieve(sessionId: string, exchange: Exchange, offer: Offer, operationId: string) {
    const raw = await this.call(`checkout/sessions/${encodeURIComponent(sessionId)}`);
    if (raw.id !== sessionId) conflict('Stripe returned an unexpected session.');
    return this.paymentFact(raw, exchange, offer, operationId);
  }
  private async paymentFact(raw: unknown, exchange: Exchange, offer: Offer, operationId: string): Promise<PaymentFact> {
    const session = sessionSchema.parse(raw);
    if (session.livemode !== (this.config.mode === 'live') || session.client_reference_id !== exchange.id
      || session.metadata.exchange_id !== exchange.id || session.metadata.version !== String(offer.version)
      || session.metadata.operation_id !== operationId || session.amount_total !== offer.buyerTotal || session.currency !== 'usd') {
      conflict('Stripe payment does not match the approved order, account mode or amount.');
    }
    const result: PaymentFact = { sessionId: session.id, status: session.status === 'expired' ? 'expired' : session.status === 'open' ? 'open' : 'unpaid',
      amount: session.amount_total, currency: session.currency, paymentIntentId: null, chargeId: null, transferId: null,
      transferred: false, transferReversed: false, transferReversedAmount: 0, refunded: false, refundedAmount: 0, destinationPaymentId: null, checkoutUrl: session.url };
    if (session.payment_status !== 'paid' || !session.payment_intent) return result;
    const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : z.string().parse(session.payment_intent.id);
    const intent = await this.call(`payment_intents/${encodeURIComponent(intentId)}?expand[]=latest_charge.transfer`);
    const transferData = object.parse(intent.transfer_data);
    if (intent.id !== intentId || intent.status !== 'succeeded' || intent.amount_received !== offer.buyerTotal || intent.currency !== 'usd'
      || intent.livemode !== (this.config.mode === 'live') || transferData.destination !== this.config.connectedAccounts[exchange.sellerId]
      || transferData.amount !== offer.item.sellerAmount) conflict('Stripe settlement does not match the approved payment.');
    const charge = object.parse(intent.latest_charge);
    if (charge.payment_intent !== intentId || charge.amount !== offer.buyerTotal || charge.currency !== 'usd'
      || charge.livemode !== (this.config.mode === 'live') || charge.paid !== true || charge.captured !== true) conflict('Stripe charge does not match the approved payment.');
    if (charge.disputed === true) conflict('Stripe reports a payment dispute. A founder must review it in Stripe before fulfillment.');
    const transfer = charge.transfer ? object.parse(charge.transfer) : null;
    result.status = 'paid'; result.paymentIntentId = intentId; result.chargeId = z.string().parse(charge.id);
    result.refundedAmount = z.number().int().min(0).max(offer.buyerTotal).parse(charge.amount_refunded);
    result.refunded = charge.refunded === true && result.refundedAmount === offer.buyerTotal;
    if (transfer) {
      if (transfer.amount !== offer.item.sellerAmount || transfer.currency !== 'usd'
        || transfer.destination !== this.config.connectedAccounts[exchange.sellerId]
        || transfer.source_transaction !== charge.id || transfer.livemode !== (this.config.mode === 'live')) conflict('Stripe transfer does not match the seller settlement.');
      result.transferId = z.string().parse(transfer.id);
      result.transferReversedAmount = z.number().int().min(0).max(offer.item.sellerAmount).parse(transfer.amount_reversed);
      result.transferred = transfer.reversed === false && transfer.amount_reversed === 0;
      result.transferReversed = transfer.reversed === true && transfer.amount_reversed === offer.item.sellerAmount;
      result.destinationPaymentId = z.string().nullable().parse(transfer.destination_payment);
    }
    return result;
  }
  async payout(sellerId: string, payment: PaymentFact, knownId?: string | null): Promise<{ id: string | null; status: 'unknown' | 'pending' | 'paid' | 'failed'; amount: number | null }> {
    const account = this.config.connectedAccounts[sellerId] ?? ''; configured(account);
    if (!payment.destinationPaymentId) return { id: null, status: 'unknown', amount: null };
    const candidates = knownId ? [await this.call(`payouts/${encodeURIComponent(knownId)}`, undefined, undefined, account)]
      : z.array(object).parse((await this.call('payouts?limit=10', undefined, undefined, account)).data);
    // Stripe can attribute balance transactions only to automatic payouts. Never infer
    // a bank payout from a transfer or from an unrelated payout on the same account.
    for (const payout of candidates) {
      if (payout.automatic !== true || payout.currency !== 'usd' || payout.livemode !== (this.config.mode === 'live') || payout.type !== 'bank_account') continue;
      const id = z.string().parse(payout.id);
      if (knownId && id !== knownId) conflict('Stripe returned an unexpected payout.');
      const transactions = await this.call(`balance_transactions?limit=100&payout=${encodeURIComponent(id)}&source=${encodeURIComponent(payment.destinationPaymentId)}`, undefined, undefined, account);
      const matching = z.array(object).parse(transactions.data).find(t => t.source === payment.destinationPaymentId && t.currency === 'usd');
      if (!matching) continue;
      const amount = z.number().int().positive().parse(matching.amount);
      const status = payout.status === 'paid' ? 'paid' : ['failed','canceled'].includes(String(payout.status)) ? 'failed' : 'pending';
      return { id, status, amount };
    }
    return { id: null, status: 'unknown', amount: null };
  }
  async expire(sessionId: string, operationId: string) { return this.call(`checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {}, operationId); }
  async refund(paymentIntentId: string, amount: number, operationId: string, reverseTransfer = true) {
    const result = await this.call('refunds', { payment_intent: paymentIntentId, amount: String(amount), reverse_transfer: String(reverseTransfer), 'metadata[operation_id]': operationId }, operationId);
    return z.object({ id: z.string(), status: z.string(), amount: z.literal(amount), currency: z.literal('usd'), payment_intent: z.literal(paymentIntentId) }).parse(result);
  }
  async retrieveRefund(id: string, paymentIntentId: string, amount: number) {
    return z.object({ id: z.literal(id), status: z.string(), amount: z.literal(amount), currency: z.literal('usd'), payment_intent: z.literal(paymentIntentId) })
      .parse(await this.call(`refunds/${encodeURIComponent(id)}`));
  }
}

export function decimalMinor(value: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) conflict('Provider rate is not valid USD money.');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1_000_000) conflict('Provider rate exceeds the pilot limit.');
  return result;
}
export const rateSchema = z.object({ id: z.string(), carrier_account_id: z.string(), carrier: z.string(), service: z.string(), rate: z.string(), currency: z.string(), delivery_days: z.number().nullable().optional() });
export const shipmentSchema = z.object({
  id: z.string(), mode: z.string(), reference: z.string().nullable(), rates: z.array(rateSchema),
  selected_rate: rateSchema.nullable(), postage_label: z.object({ id: z.string(), label_pdf_url: z.string().nullable().optional(), label_url: z.string().nullable().optional() }).nullable(),
  tracker: z.object({ id: z.string(), status: z.string(), updated_at: z.string(), tracking_code: z.string() }).nullable(),
  to_address: object, from_address: object, parcel: object, refund_status: z.string().nullable().optional(),
});
export type Shipment = z.infer<typeof shipmentSchema>;
export class EasyPostProvider {
  constructor(readonly config: ProviderConfig, private readonly fetcher: typeof fetch = fetch) {}
  async call(path: string, body?: unknown) {
    configured(this.config.easyPostKey, this.config.easyPostUser, this.config.carrierAccount);
    return providerRequest(`https://api.easypost.com/v2/${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.easyPostKey}:`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, this.fetcher);
  }
  async createShipment(operationId: string, buyer: PrivateInput, seller: PrivateInput) {
    if (!buyer.address || !seller.address || !seller.packing) conflict('Private shipping inputs are incomplete.');
    const shipment = shipmentSchema.parse(await this.call('shipments', { shipment: {
      reference: operationId, to_address: { ...buyer.address, verify: ['delivery'] }, from_address: { ...seller.address, verify: ['delivery'] },
      parcel: { weight: seller.packing.weightOz, length: seller.packing.lengthIn, width: seller.packing.widthIn, height: seller.packing.heightIn },
      carrier_accounts: [this.config.carrierAccount], options: { label_format: 'PDF' },
    } }));
    this.validateMode(shipment);
    return shipment;
  }
  validateInputs(shipment: Shipment, buyer: PrivateInput, seller: PrivateInput) {
    if (!buyer.address || !seller.address || !seller.packing) conflict('Shipping inputs are incomplete.');
    const parcel = shipment.parcel;
    if (parcel.weight !== seller.packing.weightOz || parcel.length !== seller.packing.lengthIn
      || parcel.width !== seller.packing.widthIn || parcel.height !== seller.packing.heightIn) conflict('Provider parcel does not match the approved packed measurements.');
    for (const address of [shipment.to_address, shipment.from_address]) {
      const verification = object.parse(object.parse(address.verifications).delivery);
      if (verification.success !== true) conflict('Address verification failed. Correct the private address and request another offer.');
    }
    const corrections: { buyer?: ReturnType<typeof addressSchema.parse>; seller?: ReturnType<typeof addressSchema.parse> } = {};
    // Return only normalized address fields to the corresponding owner's private
    // input. Never copy raw provider payloads into shared messages or logs.
    for (const [returned, original] of [[shipment.to_address, buyer.address], [shipment.from_address, seller.address]] as const) {
      const fields = ['street1', 'street2', 'city', 'state', 'zip', 'country'] as const;
      if (fields.some(key => String(returned[key] ?? '').trim().toUpperCase() !== original[key].trim().toUpperCase())) {
        const corrected = addressSchema.parse({ ...original, ...Object.fromEntries(fields.map(key => [key, String(returned[key] ?? '')])) });
        corrections[original === buyer.address ? 'buyer' : 'seller'] = corrected;
      }
    }
    return corrections;
  }
  validateMode(shipment: Shipment) {
    if (shipment.mode !== (this.config.mode === 'live' ? 'production' : 'test')) conflict('EasyPost shipment mode mismatch.');
  }
  async retrieve(id: string) {
    const shipment = shipmentSchema.parse(await this.call(`shipments/${encodeURIComponent(id)}`));
    this.validateMode(shipment);
    if (shipment.id !== id) conflict('EasyPost returned an unexpected shipment.');
    return shipment;
  }
  rate(shipment: Shipment) {
    const rate = shipment.rates.find(r => r.carrier_account_id === this.config.carrierAccount && r.carrier === this.config.carrier && r.service === this.config.service && r.currency === 'USD');
    if (!rate) conflict('The configured carrier/service is unavailable. Propose another supported service explicitly before approval.');
    return rate;
  }
  validateApproved(shipment: Shipment, quote: Quote) {
    this.validateMode(shipment);
    const rate = shipment.selected_rate ?? shipment.rates.find(r => r.id === quote.rateId);
    if (shipment.id !== quote.shipmentId || !rate || rate.id !== quote.rateId || rate.carrier_account_id !== quote.carrierAccountId
      || rate.carrier !== quote.carrier || rate.service !== quote.service || rate.currency !== 'USD' || decimalMinor(rate.rate) !== quote.shippingAmount) conflict('Shipping price/service changed. Fresh approval is required.');
  }
  async buy(quote: Quote) {
    const current = await this.retrieve(quote.shipmentId); this.validateApproved(current, quote);
    if (current.postage_label) return current;
    const purchased = shipmentSchema.parse(await this.call(`shipments/${encodeURIComponent(quote.shipmentId)}/buy`, { rate: { id: quote.rateId } }));
    this.validateApproved(purchased, quote); return purchased;
  }
  async refundLabel(id: string) { return this.call(`shipments/${encodeURIComponent(id)}/refund`, {}); }
}

function signatureMatches(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function verifyStripeWebhook(body: Buffer, signature: string, secret: string, now = Date.now()) {
  configured(secret);
  const fields = signature.split(',').map(s => s.split('='));
  const timestamp = fields.find(([key]) => key === 't')?.[1] ?? '';
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  if (!fields.some(([key, value]) => key === 'v1' && signatureMatches(value ?? '', expected))) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
  return object.parse(JSON.parse(body.toString('utf8')));
}
export function verifyEasyPostWebhook(body: Buffer, signature: string, secret: string) {
  configured(secret);
  // Match EasyPost's official SDK Unicode and integer-weight normalization.
  const normalized = body.toString('utf8').replace(/("weight":\s*)(\d+)(\s*)(?=,|\})/g, '$1$2.0');
  const expected = `hmac-sha256-hex=${createHmac('sha256', secret.normalize('NFKD')).update(normalized).digest('hex')}`;
  if (!signatureMatches(signature, expected)) throw new AppError('UNAUTHENTICATED', 'Invalid webhook signature.');
  return object.parse(JSON.parse(normalized));
}
