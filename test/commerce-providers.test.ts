import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createExchange, type Offer } from '../src/commerce/domain.js';
import { decimalMinor, EasyPostProvider, providerConfig, StripeProvider, verifyEasyPostWebhook, verifyStripeWebhook } from '../src/commerce/providers.js';
import { sanitizePhoto } from '../src/commerce/assets.js';
import { compatibleDropoff } from '../src/commerce/locations.js';
import { USER_A, USER_B } from './fixtures.js';

// Deterministic contract fixtures, not sandbox evidence or usable credentials.
const config = { ...providerConfig({}, 'test'), stripeKey: 'sk_test_fixture', stripeAccount: 'acct_platform', connectedAccounts: { [USER_B]: 'acct_seller' },
  easyPostKey: 'fixture', easyPostUser: 'user_fixture', carrierAccount: 'ca_fixture', publicUrl: 'https://example.test', taxTreatment: 'Fixture', subsidy: 'Fixture' };
const exchange = createExchange(USER_A, USER_B, 'test', { item: 'Shoes', style: 'Low', size: '10', sizingSystem: 'US men', condition: 'Used' }, new Date());
const offer = { version: 1, buyerTotal: 6500, taxAmount: 0, feeAmount: 0, currency: 'USD', item: { sellerAmount: 5000 }, quote: { shipmentId: 'shp_fixture', rateId: 'rate_fixture', carrierAccountId: 'ca_fixture', carrier: 'FedEx', service: 'FEDEX_GROUND', shippingAmount: 1500 }, expiresAt: new Date(Date.now() + 3600000).toISOString() } as Offer;
const session = () => ({ id: 'cs_fixture', object: 'checkout.session', livemode: false, client_reference_id: exchange.id, amount_total: 6500, currency: 'usd',
  payment_status: 'paid', status: 'complete', payment_intent: 'pi_fixture', url: null, metadata: { exchange_id: exchange.id, version: '1', operation_id: 'op_fixture' } });
const intent = () => ({ id: 'pi_fixture', status: 'succeeded', amount_received: 6500, currency: 'usd', livemode: false,
  transfer_data: { destination: 'acct_seller', amount: 5000 }, latest_charge: { id: 'ch_fixture', payment_intent: 'pi_fixture', amount: 6500, currency: 'usd', livemode: false,
    captured: true, paid: true, disputed: false, refunded: false, amount_refunded: 0,
    transfer: { id: 'tr_fixture', amount: 5000, amount_reversed: 0, currency: 'usd', destination: 'acct_seller', source_transaction: 'ch_fixture', livemode: false, reversed: false, destination_payment: 'py_fixture' } } });
const fetchObjects = (...objects: unknown[]) => vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(objects.shift()), { status: 200 }));

describe('provider contracts', () => {
  it('checks session, intent, charge and transfer identity/mode/amount, not just checkout completion', async () => {
    const s = new StripeProvider(config, fetchObjects(session(), intent()));
    expect(await s.retrieve('cs_fixture', exchange, offer, 'op_fixture')).toMatchObject({ status: 'paid', transferred: true, transferReversed: false, refunded: false });
    for (const field of ['amount_total','currency','livemode','client_reference_id','id']) {
      const changed = { ...session(), [field]: 'forged' };
      await expect(new StripeProvider(config, fetchObjects(changed)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).rejects.toThrow();
    }
    const mismatch = intent(); mismatch.latest_charge.transfer.destination = 'acct_foreign';
    await expect(new StripeProvider(config, fetchObjects(session(), mismatch)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).rejects.toThrow('settlement');
    const unpaid = { ...session(), payment_status: 'unpaid' };
    expect(await new StripeProvider(config, fetchObjects(unpaid)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).toMatchObject({ status: 'unpaid', transferred: false });
  });
  it('keeps refund and reversal independent, including partial reversals', async () => {
    const paid = intent(); paid.latest_charge.refunded = true; paid.latest_charge.amount_refunded = 6500;
    const fact = await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, offer, 'op_fixture');
    expect(fact).toMatchObject({ refunded: true, transferred: true, transferReversed: false });
    paid.latest_charge.transfer.amount_reversed = 2500;
    expect(await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).toMatchObject({ transferred: false, transferReversed: false });
    paid.latest_charge.transfer.reversed = true; paid.latest_charge.transfer.amount_reversed = 5000;
    expect(await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).toMatchObject({ transferReversed: true });
  });
  it('persists the operation identity as Stripe idempotency key and fixes destination economics', async () => {
    const fetcher = fetchObjects({ id: 'acct_platform' }, { charges_enabled: true, capabilities: { transfers: 'active' } }, { ...session(), status: 'open', payment_status: 'unpaid' });
    await new StripeProvider(config, fetcher).checkout(exchange, offer, 'op_fixture');
    const options = fetcher.mock.calls[2]![1]!;
    expect(options.headers).toMatchObject({ 'Idempotency-Key': 'op_fixture', 'Stripe-Version': '2025-02-24.acacia' });
    const fields = new URLSearchParams(String(options.body));
    expect(fields.get('payment_method_types[0]')).toBe('card');
    expect(fields.get('payment_method_types[1]')).toBe('link');
    expect(fields.get('payment_intent_data[transfer_data][amount]')).toBe('5000');
    expect(fields.get('line_items[0][price_data][unit_amount]')).toBe('6500');
    expect([...fields.keys()].join()).not.toContain('address');
  });
  it('transfers and reverses the item plus exact seller postage reimbursement', async () => {
    const reimbursed = { ...offer, postageFunding: 'seller_reimbursed' as const };
    const fetcher = fetchObjects({ id: 'acct_platform' }, { charges_enabled: true, capabilities: { transfers: 'active' } }, { ...session(), status: 'open', payment_status: 'unpaid' });
    await new StripeProvider(config, fetcher).checkout(exchange, reimbursed, 'op_fixture');
    const fields = new URLSearchParams(String(fetcher.mock.calls[2]![1]!.body));
    expect(fields.get('payment_intent_data[transfer_data][amount]')).toBe('6500');
    expect(fields.get('line_items[0][price_data][unit_amount]')).toBe('6500');
    await expect(new StripeProvider(config, fetchObjects(session(), intent())).retrieve('cs_fixture', exchange, reimbursed, 'op_fixture')).rejects.toThrow('settlement');
    const paid = intent(); paid.transfer_data.amount = 6500; paid.latest_charge.transfer.amount = 6500;
    expect(await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, reimbursed, 'op_fixture')).toMatchObject({ transferred: true });
    paid.latest_charge.refunded = true; paid.latest_charge.amount_refunded = 6500;
    paid.latest_charge.transfer.reversed = true; paid.latest_charge.transfer.amount_reversed = 5000;
    expect(await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, reimbursed, 'op_fixture')).toMatchObject({ refunded: true, transferred: false, transferReversed: false });
    paid.latest_charge.transfer.amount_reversed = 6500;
    expect(await new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, reimbursed, 'op_fixture')).toMatchObject({ refunded: true, transferReversed: true });
    await expect(new StripeProvider(config, fetchObjects(session(), paid)).retrieve('cs_fixture', exchange, offer, 'op_fixture')).rejects.toThrow('settlement');
    const malformed = fetchObjects();
    await expect(new StripeProvider(config, malformed).checkout(exchange, { ...reimbursed, buyerTotal: 5000 }, 'op_fixture')).rejects.toThrow('settlement');
    expect(malformed).not.toHaveBeenCalled();
  });
  it('attributes only the matching automatic bank payout, using the connected account', async () => {
    const fact = await new StripeProvider(config, fetchObjects(session(), intent())).retrieve('cs_fixture', exchange, offer, 'op_fixture');
    const fetcher = fetchObjects({ data: [{ id: 'po_manual', automatic: false }, { id: 'po_fixture', automatic: true, currency: 'usd', livemode: false, status: 'paid', type: 'bank_account' }] }, { data: [{ source: 'py_fixture', currency: 'usd', amount: 5000 }] });
    expect(await new StripeProvider(config, fetcher).payout(USER_B, fact)).toEqual({ id: 'po_fixture', status: 'paid', amount: 5000 });
    expect(fetcher.mock.calls[1]![0]).toContain('source=py_fixture');
    expect(fetcher.mock.calls[1]![1]!.headers).toMatchObject({ 'Stripe-Account': 'acct_seller' });
    expect(await new StripeProvider(config, fetchObjects({ data: [{ automatic: false }] })).payout(USER_B, fact)).toMatchObject({ status: 'unknown' });
  });
  it('rejects unsupported money, changed rates/services/accounts and wrong mode', () => {
    expect(decimalMinor('15.01')).toBe(1501);
    for (const value of ['1e3','15.001','-1','NaN','10000001']) expect(() => decimalMinor(value)).toThrow();
    const shipping = new EasyPostProvider(config);
    const rate = { id: 'rate_fixture', carrier_account_id: 'ca_fixture', carrier: 'FedEx', service: 'FEDEX_GROUND', rate: '15.00', currency: 'USD' };
    const shipment = { id: 'shp_fixture', mode: 'test', reference: null, rates: [rate], selected_rate: null, postage_label: null, tracker: null, from_address: {}, to_address: {}, parcel: {} };
    shipping.validateApproved(shipment, offer.quote);
    for (const patch of [{ rate: '15.01' }, { service: 'OTHER' }, { carrier_account_id: 'foreign' }, { currency: 'CAD' }]) {
      expect(() => shipping.validateApproved({ ...shipment, rates: [{ ...rate, ...patch }] }, offer.quote)).toThrow();
    }
    expect(() => shipping.validateApproved({ ...shipment, mode: 'production' }, offer.quote)).toThrow('mode');
  });
});

describe('webhook verification and private artifacts', () => {
  it('verifies Stripe raw bytes, timestamp and rotating signatures; rejects alteration and stale replay', () => {
    const body = Buffer.from('{"id":"evt_fixture"}'); const now = 1790154000000; const t = String(now / 1000);
    const signature = createHmac('sha256', 'fixture-secret').update(`${t}.`).update(body).digest('hex');
    expect(verifyStripeWebhook(body, `t=${t},v1=bad,v1=${signature}`, 'fixture-secret', now).id).toBe('evt_fixture');
    expect(() => verifyStripeWebhook(Buffer.from('{}'), `t=${t},v1=${signature}`, 'fixture-secret', now)).toThrow();
    expect(() => verifyStripeWebhook(body, `t=${t},v1=${signature}`, 'fixture-secret', now + 301000)).toThrow();
  });
  it('matches EasyPost integer-weight normalization and Unicode secret handling', () => {
    const body = Buffer.from('{"weight":16,"id":"evt_fixture"}');
    const secret = 'fixturé';
    const signature = 'hmac-sha256-hex=' + createHmac('sha256', secret.normalize('NFKD')).update('{"weight":16.0,"id":"evt_fixture"}').digest('hex');
    expect(verifyEasyPostWebhook(body, signature, secret).id).toBe('evt_fixture');
    expect(() => verifyEasyPostWebhook(body, signature, 'wrong')).toThrow();
  });
  it('decodes/re-encodes private photos, strips metadata, bounds pixels/bytes and rejects other MIME', async () => {
    const source = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).withExif({ IFD0: { Artist: 'PRIVATE_CANARY' } }).jpeg().toBuffer();
    expect((await sharp(source).metadata()).exif).toBeDefined();
    const result = await sanitizePhoto(source);
    expect((await sharp(result).metadata()).exif).toBeUndefined();
    expect(result.includes(Buffer.from('PRIVATE_CANARY'))).toBe(false);
    await expect(sanitizePhoto(Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow('5 MB');
    await expect(sanitizePhoto(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))).rejects.toThrow('JPEG or PNG');
  });
  it('requires a staffed location with the actual Ground service and usable PDF path', () => {
    const location = { locationId: 'loc_fixture', locationType: 'FEDEX_OFFICE', locationAttributeTypes: ['GROUND_DROPOFFS'],
      contactAndAddress: { displayName: 'Fixture location', address: { streetLines: ['123 Fixture'], city: 'City', stateOrProvinceCode: 'NY', postalCode: '10001', countryCode: 'US' } },
      storeHours: [{ dayofweek: 'MON', operationalHoursType: 'OPEN_BY_HOURS', operationalHours: [{ begins: '09:00:00', ends: '17:00:00' }] }],
      carrierDetailList: [{ serviceType: 'FEDEX_GROUND', carrierCodeType: 'FDXG', countryRelationshipType: 'DOMESTIC' }] };
    const packing = { weightOz: 32, lengthIn: 14, widthIn: 10, heightIn: 6, packed: true as const, canPrint: true };
    const raw = { output: { locationDetailList: [location] } };
    expect(compatibleDropoff(raw, 'FEDEX_GROUND', packing)).toMatchObject({ providerId: 'loc_fixture', artifact: 'pdf' });
    expect(() => compatibleDropoff(raw, 'FEDEX_GROUND', { ...packing, canPrint: false })).toThrow('printer');
    expect(() => compatibleDropoff(raw, 'EXPRESS', packing)).toThrow('No verified');
    expect(() => compatibleDropoff({ output: { locationDetailList: [{ ...location, locationType: 'FEDEX_DROPBOX' }] } }, 'FEDEX_GROUND', packing)).toThrow();
  });
});
