import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';

export const money = z.number().int().min(0).max(1_000_000);
export const shortText = z.string().trim().min(1).max(500);
export const requestSchema = z.object({
  item: shortText, style: shortText, size: shortText,
  sizingSystem: z.enum(['US men', 'US women', 'US kids', 'UK', 'EU', 'not applicable']),
  condition: shortText,
}).strict();
export const itemSchema = z.object({
  itemId: z.uuid(), description: shortText, size: shortText, sizingSystem: requestSchema.shape.sizingSystem,
  condition: shortText, defects: z.string().trim().max(1_000),
  photoIds: z.array(z.uuid()).min(1).max(6), sellerAmount: money.refine(v => v >= 50),
}).strict();
export const addressSchema = z.object({
  name: shortText, street1: shortText, street2: z.string().trim().max(200),
  city: shortText, state: z.string().regex(/^[A-Z]{2}$/), zip: z.string().regex(/^\d{5}(-\d{4})?$/),
  country: z.literal('US'), phone: z.string().regex(/^\+1\d{10}$/),
}).strict();
export const packingSchema = z.object({
  weightOz: z.number().positive().max(1_120), lengthIn: z.number().positive().max(60),
  widthIn: z.number().positive().max(60), heightIn: z.number().positive().max(60),
  packed: z.literal(true), canPrint: z.boolean(),
}).strict();
export const draftRequestSchema = z.object({ request: requestSchema, privateBudget: money.refine(v => v >= 50) }).strict();
export type RequestDetails = z.infer<typeof requestSchema>;
export type ItemDetails = z.infer<typeof itemSchema>;
export type Address = z.infer<typeof addressSchema>;
export type Packing = z.infer<typeof packingSchema>;
export type Mode = 'test' | 'live';

export interface Dropoff {
  providerId: string; name: string; address: string; hours: string; mapUrl: string;
  restrictions?: string;
  checkedAt: string; carrier: string; service: string; artifact: 'pdf' | 'label_qr';
}
export interface Quote {
  shipmentId: string; rateId: string; carrierAccountId: string; carrier: string; service: string;
  shippingAmount: number; currency: 'USD'; expiresAt: string; estimatedDays: number | null;
  originVersion: number; destinationVersion: number; packingVersion: number;
  artifact: 'pdf' | 'label_qr'; dropoff: Dropoff;
}
export type PostageFunding = 'platform' | 'seller_reimbursed';
export interface Settlement {
  postageFunding: PostageFunding; postageReimbursement: number; sellerTransferAmount: number;
}
export interface Offer {
  version: number; item: ItemDetails; quote: Quote; taxAmount: number; feeAmount: number;
  buyerTotal: number; currency: 'USD'; expiresAt: string; shipBy: string;
  subsidy: string; taxTreatment: string;
  /** Missing only on historical platform-funded offers. Never reinterpret them. */
  postageFunding?: PostageFunding;
  connectedShipping?: { authorizationId:string; provider:'shippo'; endpoint:string; providerMode:'live'; accountOwnerRole:'seller' };
}
export interface ApprovalBinding {
  actorId: string; operation: 'buy' | 'sell_and_postage'; exchangeId: string; version: number;
  amount: number; currency: 'USD'; destinationVersion: number; originVersion: number;
  service: string; expiresAt: string; digest: string; settlement?: Settlement;
}
export interface Exchange {
  id: string; buyerId: string; sellerId: string; mode: Mode;
  request: RequestDetails; requestShared: boolean;
  stage: 'draft' | 'waiting_for_seller' | 'declined' | 'preparing_offer' | 'offered' | 'awaiting_payment'
    | 'fulfilling' | 'completed' | 'cancelled' | 'expired' | 'needs_attention';
  itemDraft: ItemDetails | null; item: ItemDetails | null; offers: Offer[];
  approvals: ApprovalBinding[]; revision: number; negotiationTurns: number;
  payment: 'unpaid' | 'pending' | 'paid' | 'failed' | 'refund_pending' | 'refunded' | 'refund_failed' | 'partially_refunded';
  shipping: 'none' | 'label_pending' | 'label_ready' | 'in_transit' | 'delivered' | 'exception';
  transfer: 'pending' | 'transferred' | 'reversed' | 'partially_reversed'; payout: 'unknown' | 'pending' | 'paid' | 'failed';
  sellerDroppedAt: string | null; buyerReceivedAt: string | null;
  carrierAcceptedAt: string | null; trackingUpdatedAt: string | null;
  cancellationRequested: boolean; problem: string | null;
  operationIssues?: Record<string, string>;
  resolution?: { id: string; remedy: 'resume' | 'refund' | 'return' | 'absorb_postage' | 'renew_postage'; reason: string; offerDigest: string; amount: number;
    currency: 'USD'; expiresAt: string; approvedBy: string[];
    postageRenewal?: { authorizationId: string; accessDigest: string; operationId: string } };
  returnPlan?: ReturnPlan;
  shippingData?: ShippingDataConsent;
  createdAt: string; updatedAt: string; expiresAt: string;
}
export interface PrivateInput {
  budget: number | null; address: Address | null; addressVersion: number;
  packing: Packing | null; packingVersion: number;
  returnPacking?: Packing; returnPackingVersion?: number;
  suggestedAddress?: Address;
  agentAction?: PreparedAction;
  discoveryPostcode?: string; discoveryVersion?: number;
  verifiedDropoff?: import('./verified-dropoff.js').VerifiedDropoff;
  connectedOfferDraft?: import('./connected-offer.js').ConnectedOfferDraft;
  connectedReturnDraft?: import('./connected-return.js').ConnectedReturnDraft;
  connectedReturn?: {version:number;resolutionId:string;shipping:import('./connected-offer.js').ConnectedShipping};
  connectedShipping?: Record<string,import('./connected-offer.js').ConnectedShipping>;
}
/** Preparations do not grant authority. The authenticated owner reviews the
 * exact command, and execution still uses all normal commerce guards. */
export const preparedCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('message'), kind: z.enum(['question', 'answer', 'counteroffer']), text: shortText }).strict(),
  z.object({ type: z.literal('decline'), reason: shortText }).strict(),
  z.object({ type: z.literal('cancel'), reason: shortText }).strict(),
  z.object({ type: z.literal('problem'), reason: shortText }).strict(),
  z.object({ type: z.literal('quote') }).strict(),
  z.object({ type: z.literal('checkout') }).strict(),
  z.object({ type: z.literal('propose_shipping_data'), connectionId: z.uuid() }).strict(),
  z.object({ type: z.literal('propose_resolution'), remedy: z.enum(['resume','refund','return','absorb_postage','renew_postage']), reason: shortText }).strict(),
]);
export interface ShippingDataConsent {
  /** Historical permissions without a journey cover the original sale only. */
  journey?: 'return'; resolutionId?: string;
  id: string; connectionId: string; generation: string; endpoint: string; accountOwnerId: string;
  originVersion: number; destinationVersion: number; packingVersion: number;
  expiresAt: string; digest: string; approvedBy: string[]; declined: boolean;
}
export interface PreparedAction {
  id: string; revision: number; command: z.infer<typeof preparedCommandSchema>;
  explanation: string; expiresAt: string; digest: string;
}
export interface ReturnPlan {
  funding?: 'unselected';
  resolutionId: string; version: number; quote: Quote | null; subsidy: string; approvals: string[];
  shipping: 'none' | 'label_pending' | 'label_ready' | 'in_transit' | 'delivered' | 'exception';
  droppedAt: string | null; carrierAcceptedAt: string | null; trackingUpdatedAt: string | null; receivedAt: string | null;
}
export type MessageKind = 'request' | 'seller_response' | 'decline' | 'question' | 'answer' | 'counteroffer' | 'offer' | 'status';
export interface AgentMessage {
  id: string; exchangeId: string; senderId: string; recipientId: string;
  kind: MessageKind; payload: unknown; createdAt: string; readAt: string | null;
}
export type OperationKind = 'quote' | 'checkout' | 'label' | 'refund' | 'cancel_checkout' | 'label_refund' | 'payout' | 'return_quote' | 'return_label';
export interface Operation {
  id: string; exchangeId: string; kind: OperationKind; version: number; mode: Mode;
  state: 'pending' | 'running' | 'uncertain' | 'succeeded' | 'failed';
  attempts: number; providerId: string | null; result: Record<string, unknown> | null;
  createdAt: string; updatedAt: string;
}

export function conflict(message: string): never { throw new AppError('COMMERCE_CONFLICT', message); }
export function requireParticipant(exchange: Exchange, userId: string) {
  if (exchange.buyerId !== userId && exchange.sellerId !== userId) throw new AppError('NOT_FOUND', 'Exchange not found.');
}
export function requireRole(exchange: Exchange, userId: string, role: 'buyer' | 'seller') {
  requireParticipant(exchange, userId);
  if (userId !== (role === 'buyer' ? exchange.buyerId : exchange.sellerId)) throw new AppError('FORBIDDEN', 'This action belongs to the other participant.');
}
export function mutable(exchange: Exchange, now: Date) {
  if (exchange.payment !== 'unpaid' || ['cancelled', 'expired', 'completed', 'declined'].includes(exchange.stage)) {
    conflict('This exchange cannot be changed. Resolve the existing payment or start a new request.');
  }
  if (Date.parse(exchange.expiresAt) <= now.getTime()) conflict('This request has expired.');
}
export function currentOffer(exchange: Exchange): Offer {
  const offer = exchange.offers.at(-1);
  if (!offer) conflict('A verified shipping quote and offer are required.');
  return offer;
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
/** One calculation for approvals, Checkout, transfer reversal and bank payout.
 * This policy is persisted on the offer, never read from a mutable global setting. */
export function offerSettlement(offer: Offer): Settlement {
  const postageFunding = offer.postageFunding === undefined ? 'platform' : offer.postageFunding;
  if (!['platform', 'seller_reimbursed'].includes(postageFunding)) conflict('Unsupported postage funding terms.');
  const amounts = [offer.item.sellerAmount, offer.quote.shippingAmount, offer.taxAmount, offer.feeAmount];
  if (offer.currency !== 'USD' || amounts.some(amount => !Number.isSafeInteger(amount) || amount < 0)
    || !Number.isSafeInteger(offer.buyerTotal) || offer.buyerTotal < 50 || offer.buyerTotal > 1_000_000
    || amounts.reduce((sum, amount) => sum + amount, 0) !== offer.buyerTotal) conflict('Invalid approved settlement amounts.');
  const postageReimbursement = postageFunding === 'seller_reimbursed' ? offer.quote.shippingAmount : 0;
  return { postageFunding, postageReimbursement, sellerTransferAmount: offer.item.sellerAmount + postageReimbursement };
}
export function approvalFor(exchange: Exchange, userId: string): ApprovalBinding {
  requireParticipant(exchange, userId);
  const offer = currentOffer(exchange);
  const buyer = userId === exchange.buyerId;
  return {
    actorId: userId, operation: buyer ? 'buy' : 'sell_and_postage', exchangeId: exchange.id,
    version: offer.version, amount: buyer ? offer.buyerTotal : offer.quote.shippingAmount,
    currency: offer.currency, destinationVersion: offer.quote.destinationVersion,
    originVersion: offer.quote.originVersion, service: `${offer.quote.carrier}/${offer.quote.service}`,
    expiresAt: offer.expiresAt, digest: digest(offer),
    ...(offer.postageFunding === undefined ? {} : { settlement: offerSettlement(offer) }),
  };
}
export function approve(exchange: Exchange, actorId: string, raw: unknown, now: Date) {
  requireParticipant(exchange, actorId);
  if (exchange.stage !== 'offered') conflict('The offer is no longer awaiting approval.');
  const expected = approvalFor(exchange, actorId);
  if (Date.parse(expected.expiresAt) <= now.getTime()) conflict('This offer has expired. Request a fresh quote.');
  if (stableJson(raw) !== stableJson(expected)) conflict('The approval does not match the current offer.');
  if (exchange.approvals.some(a => a.actorId === actorId)) conflict('This offer has already been approved.');
  exchange.approvals.push(expected);
}
export function invalidate(exchange: Exchange) {
  exchange.approvals = [];
  exchange.stage = 'preparing_offer';
}
export function createExchange(buyerId: string, sellerId: string, mode: Mode, request: RequestDetails, now: Date): Exchange {
  return {
    id: randomUUID(), buyerId, sellerId, mode, request, requestShared: false, stage: 'draft',
    itemDraft: null, item: null, offers: [], approvals: [], revision: 1, negotiationTurns: 0,
    payment: 'unpaid', shipping: 'none', transfer: 'pending', payout: 'unknown',
    sellerDroppedAt: null, buyerReceivedAt: null, cancellationRequested: false, problem: null,
    carrierAcceptedAt: null, trackingUpdatedAt: null,
    createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
  };
}

/** Explicit projection: never return the aggregate by spreading it into an API response. */
export function exchangeView(exchange: Exchange, userId: string) {
  requireParticipant(exchange, userId);
  if (!exchange.requestShared && userId !== exchange.buyerId) throw new AppError('NOT_FOUND', 'Exchange not found.');
  return {
    id: exchange.id, mode: exchange.mode, role: userId === exchange.buyerId ? 'buyer' : 'seller',
    request: exchange.request, requestShared: exchange.requestShared, stage: exchange.stage,
    itemDraft: userId === exchange.sellerId ? exchange.itemDraft : null, item: exchange.item,
    offer: exchange.stage === 'preparing_offer' ? null : exchange.offers.at(-1) ?? null,
    approval: exchange.stage === 'offered' ? approvalFor(exchange, userId) : null,
    approvedByMe: exchange.approvals.some(a => a.actorId === userId),
    approvalCount: exchange.approvals.length, revision: exchange.revision,
    settlement: exchange.stage === 'preparing_offer' || !exchange.offers.length ? null : offerSettlement(currentOffer(exchange)),
    payment: exchange.payment, shipping: exchange.shipping, transfer: exchange.transfer, payout: exchange.payout,
    sellerDroppedAt: exchange.sellerDroppedAt, buyerReceivedAt: exchange.buyerReceivedAt,
    carrierAcceptedAt: exchange.carrierAcceptedAt, trackingUpdatedAt: exchange.trackingUpdatedAt,
    cancellationRequested: exchange.cancellationRequested, problem: exchange.problem ?? Object.values(exchange.operationIssues ?? {})[0] ?? null,
    resolution: exchange.resolution ?? null, resolutionBinding: exchange.resolution ? resolutionBinding(exchange, userId) : null,
    returnPlan: exchange.returnPlan ?? null, returnBinding: exchange.returnPlan?.quote && !exchange.offers.at(-1)?.connectedShipping ? returnBinding(exchange, userId) : null,
    createdAt: exchange.createdAt, updatedAt: exchange.updatedAt, expiresAt: exchange.expiresAt,
  };
}

export const humanCommandSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('share_connected_return'),draftId:z.uuid(),draftDigest:z.string().length(64)}).strict(),
  z.object({type:z.literal('dismiss_connected_return'),draftId:z.uuid()}).strict(),
  z.object({type:z.literal('share_connected_offer'),draftId:z.uuid(),draftDigest:z.string().length(64)}).strict(),
  z.object({type:z.literal('dismiss_connected_offer'),draftId:z.uuid()}).strict(),
  z.object({ type: z.literal('propose_shipping_data'), connectionId: z.uuid() }).strict(),
  z.object({ type: z.literal('decide_shipping_data'), consentId: z.uuid(), consentDigest: z.string().length(64),
    approve: z.boolean(), acknowledgeServiceAccountAccess: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('share_request'), requestDigest: z.string().length(64) }).strict(),
  z.object({ type: z.literal('decline'), reason: shortText }).strict(),
  z.object({ type: z.literal('share_item'), item: itemSchema }).strict(),
  z.object({ type: z.literal('address'), address: addressSchema }).strict(),
  z.object({ type: z.literal('packing'), packing: packingSchema }).strict(),
  z.object({ type: z.literal('approve'), binding: z.unknown(), acknowledgeSellerPostageReimbursement: z.literal(true).optional(), acknowledgeConnectedShipping:z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('checkout') }).strict(),
  z.object({ type: z.literal('quote') }).strict(),
  z.object({ type: z.literal('cancel'), reason: shortText }).strict(),
  z.object({ type: z.literal('dropped_off') }).strict(),
  z.object({ type: z.literal('received') }).strict(),
  z.object({ type: z.literal('problem'), reason: shortText }).strict(),
  z.object({ type: z.literal('retry_operation'), operationId: z.uuid(), reason: shortText }).strict(),
  z.object({ type: z.literal('retry_delivery'), messageId: z.uuid() }).strict(),
  z.object({ type: z.literal('research_area'), postcode: z.string().regex(/^\d{5}$/) }).strict(),
  z.object({ type: z.literal('retry_research'), researchId: z.uuid() }).strict(),
  z.object({ type: z.literal('decide_mcp_inspection'), researchId: z.uuid(), inspectionDigest: z.string().length(64), approve: z.boolean() }).strict(),
  z.object({ type: z.literal('approve_agent_action'), actionId: z.uuid(), actionDigest: z.string().length(64) }).strict(),
  z.object({ type: z.literal('dismiss_agent_action'), actionId: z.uuid() }).strict(),
  z.object({ type: z.literal('attach_provider_reference'), operationId: z.uuid(), providerId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), reason: shortText }).strict(),
  z.object({ type: z.literal('propose_resolution'), remedy: z.enum(['resume','refund','return','absorb_postage','renew_postage']), reason: shortText }).strict(),
  z.object({ type: z.literal('approve_resolution'), binding: z.unknown() }).strict(),
  z.object({ type: z.literal('return_packing'), packing: packingSchema }).strict(),
  z.object({ type: z.literal('return_quote') }).strict(),
  z.object({ type: z.literal('approve_return'), binding: z.unknown() }).strict(),
  z.object({ type: z.literal('return_dropped_off') }).strict(),
  z.object({ type: z.literal('return_received') }).strict(),
  z.object({ type: z.literal('message'), kind: z.enum(['question', 'answer', 'counteroffer']), text: shortText }).strict(),
]);
export type HumanCommand = z.infer<typeof humanCommandSchema>;

export function resolutionBinding(e: Exchange, actor: string) {
  requireParticipant(e, actor);
  if (!e.resolution) conflict('No resolution is awaiting approval.');
  const { approvedBy: _approvedBy, ...terms } = e.resolution;
  return { actorId: actor, exchangeId: e.id, operation: 'resolve_problem', ...terms };
}
export function returnBinding(e: Exchange, actor: string) {
  requireParticipant(e, actor);
  const plan = e.returnPlan;
  if (!plan?.quote) conflict('A separate return quote is required.');
  return { actorId: actor, exchangeId: e.id, operation: 'return_postage', resolutionId: plan.resolutionId, version: plan.version,
    amount: plan.quote.shippingAmount, currency: 'USD', refundAfterReceipt: currentOffer(e).buyerTotal,
    service: `${plan.quote.carrier}/${plan.quote.service}`, expiresAt: plan.quote.expiresAt,
    originVersion: plan.quote.originVersion, destinationVersion: plan.quote.destinationVersion,
    digest: digest({ quote: plan.quote, subsidy: plan.subsidy, offer: currentOffer(e) }) };
}

export function reconciledStage(e: Exchange) {
  if (e.problem || Object.keys(e.operationIssues ?? {}).length) { e.stage = 'needs_attention'; return; }
  if (e.payment === 'refunded') { e.stage = e.transfer === 'reversed' ? 'cancelled' : 'needs_attention'; return; }
  if (e.cancellationRequested) return;
  if (e.payment === 'paid') e.stage = e.shipping === 'delivered' && e.buyerReceivedAt && e.transfer === 'transferred' ? 'completed' : 'fulfilling';
}
