import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { conflict, currentOffer, digest, mutable, requireRole, type Exchange } from './domain.js';
import type { CommerceService } from './service.js';

export function requireReturnPlanning(e:Exchange) {
  const plan=e.returnPlan, resolution=e.resolution;
  if(!plan || plan.shipping!=='none' || e.payment!=='paid' || !resolution || resolution.remedy!=='return'
    || resolution.id!==plan.resolutionId || resolution.offerDigest!==digest(currentOffer(e))
    || ![e.buyerId,e.sellerId].every(id=>resolution.approvedBy.includes(id))) {
    conflict('Both participants must agree to a return before preparing its shipping details.');
  }
  return plan;
}
export function shippingAddressVersion(e:Exchange,owner:string) {
  const p=e.shippingData;
  if(!p) conflict('Shipping data permission is required.');
  const origin= p.journey==='return' ? e.buyerId : e.sellerId;
  return owner===origin ? p.originVersion : p.destinationVersion;
}

/** Permission to disclose the exact private form versions for free address
 * validation/rate lookup. This NEVER grants spending or shipment authority.
 * Stored in the existing participant aggregate; no private address is copied. */
export async function proposeShippingData(commerce: CommerceService, sql: PoolClient, e: Exchange,
  actor: string, connectionId: string, now: Date) {
  requireRole(e, actor, 'seller');
  const returning=!!e.returnPlan;
  if(returning) requireReturnPlanning(e);
  else {
    mutable(e, now);
    if (!e.item || !e.requestShared || e.problem || e.cancellationRequested) conflict('Confirm the item and resolve the exchange before sharing shipping data.');
  }
  const [buyer, seller] = await Promise.all([
    commerce.repository.privateInput(e, e.buyerId, sql), commerce.repository.privateInput(e, e.sellerId, sql),
  ]);
  if (!buyer.address || !seller.address || !(returning ? buyer.returnPacking : seller.packing)) conflict('Both private addresses and the packed dimensions are required.');
  if(returning && !Object.values(seller.connectedShipping ?? {}).some(s=>s.connectionId===connectionId
    && e.offers.some(o=>o.connectedShipping?.authorizationId===s.authorizationId))) {
    conflict('Use the original seller shipping account for this return.');
  }
  const connection = (await sql.query<{ endpoint: string; generation: string }>(`select endpoint,generation from pilot_connections
    where id=$1 and owner_id=$2 and exchange_id=$3 and mode=$4 and state='connected'`, [connectionId, actor, e.id, e.mode])).rows[0];
  if (!connection) conflict('Connect and inspect the seller service account first.');
  const terms = { id: randomUUID(), connectionId, generation: connection.generation, endpoint: connection.endpoint, accountOwnerId: actor,
    originVersion: returning ? buyer.addressVersion : seller.addressVersion, destinationVersion: returning ? seller.addressVersion : buyer.addressVersion,
    packingVersion: returning ? buyer.returnPackingVersion! : seller.packingVersion,
    ...(returning ? {journey:'return' as const,resolutionId:e.returnPlan!.resolutionId}:{}),
    expiresAt: new Date(returning ? now.getTime()+30*60_000 : Math.min(now.getTime() + 30 * 60_000, Date.parse(e.expiresAt))).toISOString() };
  e.shippingData = { ...terms, digest: digest({ exchangeId: e.id, mode: e.mode, purpose: returning?'free_return_shipping_rates_only':'free_shipping_rates_only', ...terms }), approvedBy: [], declined: false };
  await commerce.repository.event(sql, e, actor, 'shipping_data_proposed', e.shippingData);
  // Both see only the proposal identity. Each reads their private form in Actions.
  for (const recipient of [e.buyerId, e.sellerId]) await commerce.repository.message(sql, e, actor, recipient, 'status', {
    action: 'review_shipping_data', consentId: terms.id,
  });
}
async function inputsAndValidity(commerce: CommerceService, e: Exchange, sql: PoolClient | undefined, now: Date) {
  const plan = e.shippingData;
  const [buyer, seller] = await Promise.all([
    commerce.repository.privateInput(e, e.buyerId, sql), commerce.repository.privateInput(e, e.sellerId, sql),
  ]);
  if (!plan) return { plan, buyer, seller, valid: false };
  const connection = (await (sql ?? commerce.repository.pool).query<{ id: string }>(`select id from pilot_connections
    where id=$1 and owner_id=$2 and exchange_id=$3 and mode=$4 and state='connected' and generation=$5 and endpoint=$6`,
    [plan.connectionId, e.sellerId, e.id, e.mode, plan.generation, plan.endpoint])).rows[0];
  const returning=plan.journey==='return';
  let returnValid=false;
  if(returning) {try {returnValid=requireReturnPlanning(e).resolutionId===plan.resolutionId;} catch { /* Stale return consent. */ }}
  const outboundValid=e.payment === 'unpaid'
    && !['cancelled','declined','expired','completed'].includes(e.stage) && !e.cancellationRequested && !e.problem
    && Date.parse(e.expiresAt) > now.getTime();
  const valid = !!connection && plan.accountOwnerId === e.sellerId && (returning ? returnValid : outboundValid)
    && Date.parse(plan.expiresAt) > now.getTime() && !!buyer.address && !!seller.address
    && (returning ? !!buyer.returnPacking && plan.originVersion===buyer.addressVersion && plan.destinationVersion===seller.addressVersion
      && plan.packingVersion===buyer.returnPackingVersion : !!seller.packing && plan.originVersion===seller.addressVersion
      && plan.destinationVersion===buyer.addressVersion && plan.packingVersion===seller.packingVersion);
  return { plan, buyer, seller, valid };
}
export async function decideShippingData(commerce: CommerceService, sql: PoolClient, e: Exchange, actor: string,
  consentId: string, consentDigest: string, approve: boolean, acknowledgeAccountAccess: boolean | undefined, now: Date) {
  const plan = e.shippingData;
  if (!plan || plan.id !== consentId || plan.digest !== consentDigest) conflict('The shipping data proposal changed. Review it again.');
  if (approve) {
    if (acknowledgeAccountAccess !== true) conflict('Confirm that the service and seller account can access your shipping details.');
    if (plan.declined || !(await inputsAndValidity(commerce,e,sql,now)).valid) conflict('Shipping data permission expired or its inputs or connection changed.');
    if (!plan.approvedBy.includes(actor)) plan.approvedBy.push(actor);
  } else {
    plan.declined = true; plan.approvedBy = [];
  }
  await commerce.repository.event(sql,e,actor,'shipping_data_decision',{ consentId, consentDigest, approve });
  // The peer receives an approved reference through Hermes A2A, never addresses.
  for (const recipient of [e.buyerId,e.sellerId]) await commerce.repository.message(sql,e,actor,recipient,'status',{
    action:'shipping_data_update',consentId,
  });
}
export async function shippingDataView(commerce: CommerceService, e: Exchange, actor: string, now: Date) {
  if (!e.shippingData) return null;
  const { plan, valid } = await inputsAndValidity(commerce,e,undefined,now);
  const p = plan!;
  return { id: p.id, digest: p.digest, endpoint: p.endpoint, accountOwnerRole: 'seller' as const,
    purpose: p.journey==='return' ? 'free_return_shipping_rates_only' as const : 'free_shipping_rates_only' as const, expiresAt: p.expiresAt,
    state: p.declined ? 'declined' : !valid ? 'expired' : p.approvedBy.includes(e.buyerId) && p.approvedBy.includes(e.sellerId) ? 'approved' : 'review',
    approvedByMe: p.approvedBy.includes(actor), approvalCount: p.approvedBy.length,
    ownAddressVersion: shippingAddressVersion(e,actor), packingVersion: p.packingVersion };
}
/** For a server worker's durable before-dispatch transaction only. The caller
 * locks the exchange first, then this locks the connection to fence disconnect.
 * The returned private values MUST NOT be exposed through a model/API projection.
 * A separate execution contract must establish that the operation is free. */
export async function requireShippingDataConsent(commerce: CommerceService, sql: PoolClient, e: Exchange,
  connectionId: string, consentId: string, now: Date) {
  if (e.mode !== commerce.mode || !commerce.founders.includes(e.buyerId) || !commerce.founders.includes(e.sellerId)) {
    conflict('Shipping data permission is not available for this pilot mode.');
  }
  const p = e.shippingData;
  if (!p || p.id !== consentId || p.connectionId !== connectionId || p.declined
    || !p.approvedBy.includes(e.buyerId) || !p.approvedBy.includes(e.sellerId)) conflict('Both owners must approve this exact shipping data disclosure.');
  await sql.query('select id from pilot_connections where id=$1 for update', [connectionId]);
  const checked = await inputsAndValidity(commerce,e,sql,now);
  if (!checked.valid) conflict('Shipping data permission expired or its inputs or connection changed.');
  return p.journey==='return' ? {origin:checked.buyer.address!,destination:checked.seller.address!,packing:checked.buyer.returnPacking!}
    : { origin: checked.seller.address!, destination: checked.buyer.address!, packing: checked.seller.packing! };
}
