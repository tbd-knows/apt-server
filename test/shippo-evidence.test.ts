import { describe, it, expect } from 'vitest';
import { shippoPayload, shippoMinorUnits, shippoShipmentArguments, shippoShipment, shippoRate, shippoCarrier,
  shippoTransaction, shippoAddressArguments,shippoAddressValidation,type ShippoShipmentBinding, type ShippoTransactionBinding } from '../src/commerce/shippo-evidence.js';
import { shippingRatesReceipt } from '../src/commerce/shipping-rates.js';
import type { ServiceResult } from '../src/commerce/mcp-execution.js';

const now = new Date('2026-09-24T12:00:00Z');
const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const binding: ShippoShipmentBinding = { operationId, accountOwner: 'fixture-account', mode: 'live',
  origin: { name: 'Seller', street1: '1 Origin Lane', street2: '', city: 'Boston', state: 'MA', zip: '02110', country: 'US', phone: '+16175550101' },
  destination: { name: 'Buyer', street1: '2 Destination Lane', street2: 'Apt 2', city: 'Boston', state: 'MA', zip: '02111', country: 'US', phone: '+16175550102' },
  packing: { lengthIn: 12, widthIn: 8, heightIn: 6, weightOz: 32, packed: true, canPrint: true } };
function receipt(payload: unknown, payloadName = 'Shipment'): ServiceResult {
  return { state: 'returned', result: { text: [], omittedContentTypes: [], structuredContent: {
    ContentType: 'application/json', StatusCode: 200, RawResponse: {}, [payloadName]: payload,
  } } };
}
const rate = () => ({ object_id: 'rate_123', shipment: 'shipment_123', object_owner: binding.accountOwner,
  object_created: now.toISOString(), test: false, carrier_account: 'carrier_123', provider: 'USPS',
  servicelevel: { token: 'usps_ground_advantage', name: 'Ground Advantage' }, amount: '8.05', currency: 'USD', estimated_days: 3 });
const shipment = () => ({ object_id: 'shipment_123', object_owner: binding.accountOwner, metadata: `tbd:${operationId}`, test: false,
  status: 'SUCCESS', address_from: { ...binding.origin }, address_to: { ...binding.destination },
  parcels: [{ object_id: 'parcel_123', length: '12.0000', width: '8', height: '6', distance_unit: 'in', weight: '32.0', mass_unit: 'oz' }],
  rates: [rate()], extra: { qr_code_requested: false } });
const transactionBinding: ShippoTransactionBinding = { operationId, accountOwner: binding.accountOwner, mode: 'live',
  rateId: 'rate_123', parcelId: 'parcel_123', artifact: 'pdf', qrRequested: false, carrierToken: 'usps' };
const transaction = () => ({ object_id: 'txn_123', object_owner: binding.accountOwner, metadata: `tbd:${operationId}`, test: false,
  rate: 'rate_123', parcel: 'parcel_123', status: 'SUCCESS', tracking_number: 'TRACKING123', label_file_type: 'PDF',
  label_url: 'https://deliver.goshippo.com/label.pdf?signature=PRIVATE_ARTIFACT_CANARY', qr_code_url: null as string | null });

describe('Shippo authenticated response evidence (fixtures, no provider requests)', () => {
  it('validates echoed address inputs and keeps corrections private without silently applying them',()=>{
    const original_address=shippoAddressArguments(binding.destination);
    expect(original_address).not.toHaveProperty('phone');
    const data={original_address,analysis:{validation_result:{value:'valid'}}};
    expect(shippoAddressValidation(receipt(data),binding.destination)).toEqual({status:'valid'});
    const recommendation={...original_address,postal_code:'02111-1234'};
    expect(shippoAddressValidation(receipt({...data,recommended_address:recommendation}),binding.destination))
      .toEqual({status:'correction_required',suggestedAddress:{...binding.destination,zip:'02111-1234'}});
    expect(binding.destination.zip).toBe('02111');
    expect(shippoAddressValidation(receipt({...data,analysis:{validation_result:{value:'invalid'}}}),binding.destination)).toEqual({status:'invalid'});
    expect(shippoAddressValidation(receipt({...data,analysis:{validation_result:{value:'partially_valid'}}}),binding.destination)).toEqual({status:'correction_required'});
    expect(()=>shippoAddressValidation(receipt({...data,original_address:{...original_address,address_line_2:''}}),binding.destination)).toThrow('Shipping evidence');
    expect(()=>shippoAddressValidation(receipt({...data,original_address:{...original_address,postal_code:'10001'}}),binding.destination)).toThrow('Shipping evidence');
    expect(()=>shippoAddressValidation(receipt({...data,recommended_address:{...recommendation,country_code:'CA'}}),binding.destination)).toThrow('Shipping evidence');
  });
  it('accepts a single successful provider envelope, including identical MCP text/structured copies', () => {
    const r = receipt({ object_id: 'id' });
    r.result!.text = [JSON.stringify(r.result!.structuredContent)];
    expect(shippoPayload(r)).toEqual({ object_id: 'id' });
    delete r.result!.structuredContent;
    expect(shippoPayload(r)).toEqual({ object_id: 'id' });
  });
  it('rejects RPC success containing provider failure, prose, conflicting envelopes, attachments or multiple payloads', () => {
    const variants: ServiceResult[] = [
      { ...receipt({}), state: 'uncertain' as const }, { ...receipt({}), state: 'returned_error' as const },
      { state: 'returned' as const, result: { text: ['Shipment ready!'], omittedContentTypes: [] } },
    ];
    const error = receipt({}); error.result!.structuredContent!.StatusCode = 409; variants.push(error);
    const ambiguous = receipt({}); ambiguous.result!.structuredContent!.OtherPayload = {}; variants.push(ambiguous);
    const conflict = receipt({}); conflict.result!.text = [JSON.stringify(receipt({ other: true }).result!.structuredContent)]; variants.push(conflict);
    const attachment = receipt({}); attachment.result!.omittedContentTypes = ['resource_link']; variants.push(attachment);
    for (const value of variants) expect(() => shippoPayload(value)).toThrow('Shipping evidence');
  });
  it('uses exact integer cents without float rounding or interpreting exponent/negative/foreign money', () => {
    for (const [value, amount] of [['0', 0], ['0.01', 1], ['8.05', 805], ['8.5', 850], ['10000.00', 1_000_000]] as const) {
      expect(shippoMinorUnits(value)).toBe(amount);
    }
    for (const value of ['-1.00', '1e2', '8.005', '10000.01', 'Infinity', '01.00', '$8.05', 8.05]) {
      expect(() => shippoMinorUnits(value)).toThrow('Shipping evidence');
    }
  });
  it('constructs only structured shipment inputs with exact dimensions and operation identity', () => {
    const args = shippoShipmentArguments(binding);
    expect(args).toEqual({ address_from: binding.origin, address_to: binding.destination,
      parcels: [{ length: '12', width: '8', height: '6', distance_unit: 'in', weight: '32', mass_unit: 'oz' }],
      metadata: `tbd:${operationId}`, async: false, extra: { qr_code_requested: false } });
    expect(shippoShipmentArguments({ ...binding, packing: { ...binding.packing, canPrint: false } }).extra.qr_code_requested).toBe(true);
    expect(() => shippoShipmentArguments({ ...binding, packing: { ...binding.packing, weightOz: 0.12345 } })).toThrow('Shipping evidence');
  });
  it('returns privacy-minimized rate evidence after checking addresses, parcel, owner, mode and operation', () => {
    const result = shippoShipment(receipt(shipment()), binding, now);
    expect(result).toMatchObject({ state: 'rated', shipmentId: 'shipment_123', parcelId: 'parcel_123', rates: [{ amount: 805, currency: 'USD', expiresAt: '2026-09-24T12:15:00.000Z' }] });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['Origin Lane', 'Destination Lane', 'fixture-account', '+1617']) expect(serialized).not.toContain(privateValue);
  });
  it.each(['object_owner', 'metadata', 'object_id', 'test', 'address_from', 'address_to', 'parcels', 'rates'])('rejects mismatched shipment %s', field => {
    const raw: Record<string, unknown> = shipment();
    const replacements: Record<string, unknown> = { object_owner: 'another-account', metadata: 'unrelated', object_id: 'other-shipment', test: true,
      address_from: { ...binding.origin, street1: 'Different street' }, address_to: { ...binding.destination, street2: '' },
      parcels: [{ ...shipment().parcels[0], weight: '31.9' }], rates: [{ ...rate(), shipment: 'other-shipment' }] };
    raw[field] = replacements[field];
    expect(() => shippoShipment(receipt(raw), binding, now, 'shipment_123')).toThrow('Shipping evidence');
  });
  it('keeps the short review window separate from the original provider purchase deadline',()=>{
    const fresh=shippoRate(rate(),{shipmentId:'shipment_123',accountOwner:binding.accountOwner,mode:'live'},now);
    expect(fresh.expiresAt).toBe('2026-09-24T12:15:00.000Z');
    expect(fresh.purchaseBefore).toBe('2026-10-01T12:00:00.000Z');
    const later=shippoRate(rate(),{shipmentId:'shipment_123',accountOwner:binding.accountOwner,mode:'live'},new Date('2026-09-25T12:00:00Z'));
    expect(later.purchaseBefore).toBe(fresh.purchaseBefore);
    expect(()=>shippoRate(rate(),{shipmentId:'shipment_123',accountOwner:binding.accountOwner,mode:'live'},new Date(fresh.purchaseBefore!))).toThrow();
  });
  it('tolerates whitespace/case and dimension order without accepting changed postal routing', () => {
    const raw = shipment(); raw.address_from.street1 = ' 1 ORIGIN  LANE '; raw.parcels[0]!.length = '6'; raw.parcels[0]!.height = '12';
    expect(shippoShipment(receipt(raw), binding, now).state).toBe('rated');
    raw.address_to.zip = '02111-1234';
    expect(() => shippoShipment(receipt(raw), binding, now)).toThrow('Shipping evidence');
  });
  it('does not treat queued, failed or missing rates as fulfillment evidence', () => {
    for (const status of ['QUEUED', 'WAITING', 'ERROR']) {
      expect(shippoShipment(receipt({ ...shipment(), status, parcels: [], rates: [] }), binding, now))
        .toEqual({ state: status === 'ERROR' ? 'error' : 'pending', shipmentId: 'shipment_123' });
    }
    expect(() => shippoShipment(receipt({ ...shipment(), rates: [] }), binding, now)).toThrow('Shipping evidence');
  });
  it('rejects a private address reflected into an otherwise valid public rate name',()=>{
    const data=shipment();data.rates[0]!.provider=binding.destination.street1;
    expect(()=>shippingRatesReceipt(receipt(data),binding)).toThrow('private input');
  });
  it('requires a QR request before allowing the no-printer rate path', () => {
    const noPrinter = { ...binding, packing: { ...binding.packing, canPrint: false } };
    expect(() => shippoShipment(receipt(shipment()), noPrinter, now)).toThrow('Shipping evidence');
    expect(shippoShipment(receipt({ ...shipment(), extra: { qr_code_requested: true } }), noPrinter, now).state).toBe('rated');
    // Requesting QR is not proof the eventual carrier/service returns one.
  });
  it.each([{ amount: '8.005' }, { currency: 'EUR' }, { test: true }, { object_owner: 'foreign' },
    { object_created: '2026-09-17T11:59:59Z' }, { object_created: '2026-09-24T13:00:00Z' }])('rejects ineligible rate %j', change => {
    expect(() => shippoRate({ ...rate(), ...change }, { ...binding, shipmentId: 'shipment_123' }, now)).toThrow('Shipping evidence');
  });
  it('binds active carrier identity to its actual account token', () => {
    const raw = { object_id: 'carrier_123', object_owner: binding.accountOwner, test: false, active: true, carrier: 'usps', account_id: 'PRIVATE_ACCOUNT' };
    expect(shippoCarrier(receipt(raw, 'CarrierAccount'), { ...binding, carrierAccountId: 'carrier_123' })).toEqual({ carrierAccountId: 'carrier_123', carrierToken: 'usps' });
    expect(() => shippoCarrier(receipt({ ...raw, active: false }), { ...binding, carrierAccountId: 'carrier_123' })).toThrow('Shipping evidence');
  });
  it('requires exact purchased transaction identity and keeps the signed artifact private', () => {
    expect(shippoTransaction(receipt(transaction(), 'Transaction'), transactionBinding, 'txn_123')).toEqual({ state: 'purchased', transactionId: 'txn_123',
      trackingNumber: 'TRACKING123', privateArtifactUrl: transaction().label_url, artifact: 'pdf' });
    for (const change of [{ rate: 'other' }, { parcel: 'other' }, { metadata: 'other' }, { object_owner: 'other' }, { test: true },
      { label_url: 'http://unsafe.com/label' }, { label_url: 'https://127.0.0.1/label' }, { tracking_number: '' }, { label_file_type: 'PNG' }]) {
      expect(() => shippoTransaction(receipt({ ...transaction(), ...change }), transactionBinding)).toThrow('Shipping evidence');
    }
    expect(() => shippoTransaction(receipt(transaction()), transactionBinding, 'other')).toThrow('Shipping evidence');
  });
  it('requires an issued USPS printing QR, never substitutes a PDF or tracking number', () => {
    const qr = { ...transactionBinding, artifact: 'label_qr' as const, qrRequested: true };
    expect(() => shippoTransaction(receipt(transaction()), qr)).toThrow('Shipping evidence');
    const raw = { ...transaction(), qr_code_url: 'https://deliver.goshippo.com/printing-qr.png?signature=PRIVATE' };
    expect(shippoTransaction(receipt(raw), qr)).toMatchObject({ state: 'purchased', artifact: 'label_qr', privateArtifactUrl: raw.qr_code_url });
    expect(() => shippoTransaction(receipt(raw), { ...qr, qrRequested: false })).toThrow('Shipping evidence');
    expect(() => shippoTransaction(receipt(raw), { ...qr, carrierToken: 'ups' })).toThrow('Shipping evidence');
  });
  it.each([['QUEUED', 'pending'], ['WAITING', 'pending'], ['ERROR', 'error'], ['REFUNDED', 'refunded'],
    ['REFUNDPENDING', 'refund_pending'], ['REFUNDREJECTED', 'refund_rejected']])('keeps %s distinct from purchased', (status, state) => {
    expect(shippoTransaction(receipt({ ...transaction(), status, label_url: null }), transactionBinding)).toEqual({ state, transactionId: 'txn_123' });
  });
  it('never exposes rejected response values through error messages', () => {
    try { shippoTransaction(receipt({ ...transaction(), rate: 'PRIVATE_REJECTED_CANARY' }), transactionBinding); }
    catch (error) { expect(String(error)).not.toContain('CANARY'); }
  });
});
