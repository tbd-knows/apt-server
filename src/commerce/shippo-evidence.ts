import { z } from 'zod';
import { addressSchema, packingSchema, digest, type Address, type Mode, type Packing } from './domain.js';
import type { ServiceResult } from './mcp-execution.js';
import { publicEndpoint } from './public-http.js';

/** Provider data contract, not permission to call a tool or spend money.
 * Official sources: docs.goshippo.com/spec/shippoapi/public-api.yaml and
 * github.com/goshippo/ai/blob/main/skills/shippo/references/response-envelope.md.
 * Only pass receipts obtained by the authenticated server transport. Models,
 * client requests and capability descriptions cannot supply provider evidence.
 */
export class ShippingEvidenceError extends Error {
  constructor() { super('Shipping evidence does not match the approved operation. Reconcile the provider record before proceeding.'); }
}
function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new ShippingEvidenceError();
}
const record = z.record(z.string(), z.unknown());
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const timestamp = z.iso.datetime({ offset: true });
const owner = z.string().min(1).max(320);
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  // Never put a rejected address, credential or signed label URL in an error.
  if (!result.success) throw new ShippingEvidenceError();
  return result.data;
}

/** A successful JSON-RPC/MCP reply can still contain a provider 4xx or a
 * pending shipment. Reject ambiguous/contradictory structured and text replies. */
export function shippoPayload(receipt: ServiceResult): Record<string, unknown> {
  requireEvidence(receipt.state === 'returned' && receipt.result);
  const result = receipt.result;
  requireEvidence(result.omittedContentTypes.length === 0);
  const candidates: Record<string, unknown>[] = [];
  if (result.structuredContent) candidates.push(result.structuredContent);
  for (const text of result.text) {
    if (!text.trim()) continue;
    try { candidates.push(parse(record, JSON.parse(text))); }
    catch { throw new ShippingEvidenceError(); }
  }
  requireEvidence(candidates.length > 0 && candidates.every(value => digest(value) === digest(candidates[0])));
  const envelope = candidates[0]!;
  requireEvidence(envelope.ContentType === 'application/json' && Number.isInteger(envelope.StatusCode)
    && Number(envelope.StatusCode) >= 200 && Number(envelope.StatusCode) < 300);
  const keys = Object.keys(envelope).filter(key => !['ContentType', 'StatusCode', 'RawResponse'].includes(key));
  requireEvidence(keys.length === 1);
  return parse(record, envelope[keys[0]!]);
}

export function shippoMinorUnits(value: unknown): number {
  requireEvidence(typeof value === 'string' && /^(0|[1-9]\d{0,4})(\.\d{1,2})?$/.test(value));
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  requireEvidence(Number.isSafeInteger(amount) && amount <= 1_000_000);
  return amount;
}
function decimal(value: number): string {
  const text = String(value);
  requireEvidence(/^(0|[1-9]\d*)(\.\d{1,4})?$/.test(text));
  return text; // Refuse unrepresentable precision; never silently round a parcel.
}
export interface ShippoShipmentBinding {
  operationId: string;
  accountOwner: string;
  mode: Mode;
  origin: Address;
  destination: Address;
  packing: Packing;
}
export function shippoOperationMetadata(operationId: string) {
  return `tbd:${parse(z.uuid(), operationId)}`;
}
/** Resolve these values from private forms, after BOTH owners' scoped sharing
 * approval. Never send the constructed arguments to an agent or peer inbox. */
export function shippoShipmentArguments(binding: ShippoShipmentBinding) {
  const origin = parse(addressSchema, binding.origin), destination = parse(addressSchema, binding.destination);
  const packing = parse(packingSchema, binding.packing);
  return {
    address_from: origin, address_to: destination,
    parcels: [{ length: decimal(packing.lengthIn), width: decimal(packing.widthIn), height: decimal(packing.heightIn),
      distance_unit: 'in', weight: decimal(packing.weightOz), mass_unit: 'oz' }],
    metadata: shippoOperationMetadata(binding.operationId), async: false,
    extra: { qr_code_requested: !packing.canPrint },
  };
}
const normal = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();
function matchingAddress(value: unknown, expected: Address) {
  const actual = parse(z.object({ name: z.string(), street1: z.string(), street2: z.string().nullish(),
    city: z.string(), state: z.string(), zip: z.string(), country: z.string(), phone: z.string().nullish() }), value);
  for (const key of ['name', 'street1', 'city', 'state', 'zip', 'country'] as const) {
    requireEvidence(normal(actual[key]) === normal(expected[key]));
  }
  requireEvidence(normal(actual.street2 ?? '') === normal(expected.street2));
  if (actual.phone) requireEvidence(actual.phone.replace(/[^0-9]/g, '') === expected.phone.replace(/[^0-9]/g, ''));
}
const measurement = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,4})?$/).transform(Number);
function matchingParcel(value: unknown, packing: Packing): string {
  const parcel = parse(z.object({ object_id: identifier, length: measurement, width: measurement, height: measurement,
    distance_unit: z.literal('in'), weight: measurement, mass_unit: z.literal('oz') }), value);
  // A carrier may reorder the three dimensions; the measured box must not change.
  requireEvidence(digest([parcel.length, parcel.width, parcel.height].sort((a,b) => a-b))
    === digest([packing.lengthIn, packing.widthIn, packing.heightIn].sort((a,b) => a-b)) && parcel.weight === packing.weightOz);
  return parcel.object_id;
}
const rateSchema = z.object({ object_id: identifier, object_owner: owner, object_created: timestamp,
  shipment: identifier, carrier_account: identifier, provider: z.string().min(1).max(120),
  servicelevel: z.object({ token: identifier, name: z.string().min(1).max(200) }),
  amount: z.string(), currency: z.literal('USD'), estimated_days: z.number().int().min(0).max(365).nullish(), test: z.boolean().optional() });
export interface ShippoRateEvidence {
  rateId: string; shipmentId: string; carrierAccountId: string; carrierName: string;
  serviceToken: string; serviceName: string; amount: number; currency: 'USD'; estimatedDays: number | null;
  expiresAt: string;
}
export function shippoRate(value: unknown, binding: { shipmentId: string; accountOwner: string; mode: Mode }, now: Date): ShippoRateEvidence {
  const rate = parse(rateSchema, value);
  requireEvidence(rate.shipment === binding.shipmentId && rate.object_owner === binding.accountOwner
    && (rate.test === undefined || rate.test === (binding.mode === 'test')));
  const created = Date.parse(rate.object_created);
  // Provider rates last seven days. Our review window is deliberately shorter.
  const expires = Math.min(created + 7 * 86_400_000, now.getTime() + 15 * 60_000);
  requireEvidence(created <= now.getTime() + 60_000 && expires > now.getTime());
  return { rateId: rate.object_id, shipmentId: rate.shipment, carrierAccountId: rate.carrier_account,
    carrierName: rate.provider, serviceToken: rate.servicelevel.token, serviceName: rate.servicelevel.name,
    amount: shippoMinorUnits(rate.amount), currency: 'USD', estimatedDays: rate.estimated_days ?? null, expiresAt: new Date(expires).toISOString() };
}
export type ShippoShipmentEvidence =
  | { state: 'pending' | 'error'; shipmentId: string }
  | { state: 'rated'; shipmentId: string; parcelId: string; rates: ShippoRateEvidence[]; qrRequested: boolean };
export function shippoShipment(receipt: ServiceResult, binding: ShippoShipmentBinding, now: Date,
  expectedShipmentId?: string): ShippoShipmentEvidence {
  const shipment = parse(z.object({ object_id: identifier, object_owner: owner, metadata: z.string(), test: z.boolean(),
    status: z.enum(['SUCCESS', 'ERROR', 'QUEUED', 'WAITING']), address_from: z.unknown(), address_to: z.unknown(),
    parcels: z.array(z.unknown()).max(1).optional(), rates: z.array(z.unknown()).max(100).optional(),
    extra: z.object({ qr_code_requested: z.boolean().optional() }).optional() }), shippoPayload(receipt));
  requireEvidence(shipment.object_owner === binding.accountOwner && shipment.test === (binding.mode === 'test')
    && shipment.metadata === shippoOperationMetadata(binding.operationId)
    && (!expectedShipmentId || shipment.object_id === expectedShipmentId));
  if (shipment.status !== 'SUCCESS') return { state: shipment.status === 'ERROR' ? 'error' : 'pending', shipmentId: shipment.object_id };
  matchingAddress(shipment.address_from, binding.origin); matchingAddress(shipment.address_to, binding.destination);
  requireEvidence(shipment.parcels?.length === 1 && shipment.rates && shipment.rates.length > 0);
  const parcelId = matchingParcel(shipment.parcels[0], binding.packing);
  if (!binding.packing.canPrint) requireEvidence(shipment.extra?.qr_code_requested === true);
  const rates = shipment.rates.map(value => shippoRate(value, { ...binding, shipmentId: shipment.object_id }, now));
  requireEvidence(new Set(rates.map(rate => rate.rateId)).size === rates.length);
  return { state: 'rated', shipmentId: shipment.object_id, parcelId, rates, qrRequested: shipment.extra?.qr_code_requested === true };
}

/** Authenticate/retrieve the carrier account selected by the rate. Never turn
 * a human display name into a carrier token or assume an account is active. */
export function shippoCarrier(receipt: ServiceResult, binding: { accountOwner: string; carrierAccountId: string; mode: Mode }) {
  const account = parse(z.object({ object_id: identifier, object_owner: owner, active: z.literal(true), carrier: identifier,
    test: z.boolean() }), shippoPayload(receipt));
  requireEvidence(account.object_owner === binding.accountOwner && account.object_id === binding.carrierAccountId
    && account.test === (binding.mode === 'test'));
  return { carrierAccountId: account.object_id, carrierToken: account.carrier };
}
export interface ShippoTransactionBinding {
  operationId: string; accountOwner: string; mode: Mode; rateId: string; parcelId: string;
  artifact: 'pdf' | 'label_qr'; qrRequested: boolean; carrierToken: string;
}
function artifactUrl(value: unknown): string {
  requireEvidence(typeof value === 'string' && value.length <= 8192 && URL.canParse(value));
  const url = new URL(value);
  requireEvidence(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
    && publicEndpoint(`${url.origin}${url.pathname}`));
  // Still private/untrusted. Fetch through a separate bounded DNS-pinned
  // artifact downloader; this function does not fetch or make a public URL.
  return value;
}
export type ShippoTransactionEvidence =
  | { state: 'pending' | 'error' | 'refunded' | 'refund_pending' | 'refund_rejected'; transactionId: string }
  | { state: 'purchased'; transactionId: string; trackingNumber: string; privateArtifactUrl: string; artifact: 'pdf' | 'label_qr' };
export function shippoTransaction(receipt: ServiceResult, binding: ShippoTransactionBinding,
  expectedTransactionId?: string): ShippoTransactionEvidence {
  const transaction = parse(z.object({ object_id: identifier, object_owner: owner, metadata: z.string(), test: z.boolean(),
    rate: identifier, parcel: identifier.optional(), status: z.enum(['WAITING', 'QUEUED', 'SUCCESS', 'ERROR', 'REFUNDED', 'REFUNDPENDING', 'REFUNDREJECTED']),
    tracking_number: z.string().max(120).nullish(), label_file_type: z.string().nullish(), label_url: z.string().nullish(), qr_code_url: z.string().nullish() }), shippoPayload(receipt));
  requireEvidence(transaction.object_owner === binding.accountOwner && transaction.test === (binding.mode === 'test')
    && transaction.metadata === shippoOperationMetadata(binding.operationId) && transaction.rate === binding.rateId
    && (!expectedTransactionId || transaction.object_id === expectedTransactionId));
  const states = { WAITING: 'pending', QUEUED: 'pending', ERROR: 'error', REFUNDED: 'refunded', REFUNDPENDING: 'refund_pending', REFUNDREJECTED: 'refund_rejected' } as const;
  if (transaction.status !== 'SUCCESS') return { state: states[transaction.status], transactionId: transaction.object_id };
  requireEvidence(transaction.parcel === binding.parcelId && transaction.tracking_number?.trim());
  let url: string;
  if (binding.artifact === 'label_qr') {
    // Current supported domestic path. A tracking barcode/PDF is never a QR.
    requireEvidence(binding.qrRequested && binding.carrierToken === 'usps');
    url = artifactUrl(transaction.qr_code_url);
  } else {
    requireEvidence(['PDF', 'PDF_4x6', 'PDF_4x8', 'PDF_A4', 'PDF_A6'].includes(transaction.label_file_type ?? ''));
    url = artifactUrl(transaction.label_url);
  }
  return { state: 'purchased', transactionId: transaction.object_id, trackingNumber: transaction.tracking_number!, privateArtifactUrl: url, artifact: binding.artifact };
}
