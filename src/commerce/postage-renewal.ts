import type { PoolClient } from 'pg';
import { approvalFor, conflict, currentOffer, digest, type Exchange, type Offer } from './domain.js';
import type { ConnectedShipping } from './connected-offer.js';
import type { CommerceService } from './service.js';

export function postageAccessDigest(connection: { id: string; generation: string; endpoint: string; inspection: unknown }) {
  return digest({ id: connection.id, generation: connection.generation, endpoint: connection.endpoint, inspection: connection.inspection });
}

/** Renewal is a second human spending decision for the exact paid sale. It
 * never edits the offer used by Stripe or allocates another label operation. */
export function renewedPostage(e: Exchange, offer: Offer, shipping: ConnectedShipping,
  connection: { id: string; generation: string; endpoint: string; inspection: unknown }, now = Date.now()) {
  const r=e.resolution,renewal=r?.postageRenewal;
  return !!r && r.remedy==='renew_postage' && !!renewal && r.offerDigest===digest(offer)
    && r.amount===offer.quote.shippingAmount && r.currency===offer.currency
    && renewal.authorizationId===shipping.authorizationId && renewal.accessDigest===postageAccessDigest(connection)
    && r.approvedBy.length===2 && [e.buyerId,e.sellerId].every(id=>r.approvedBy.includes(id))
    && Date.parse(r.expiresAt)>now && Date.parse(r.expiresAt)<Date.parse(shipping.purchaseBefore)
    && Date.parse(r.expiresAt)<=Date.parse(offer.shipBy) && e.payment==='paid' && !e.cancellationRequested && !e.returnPlan;
}

/** Exchange is locked by the command caller before connection/operation locks.
 * Any known or possibly dispatched purchase must reconcile, never renew. */
export async function postageRenewalContext(commerce: CommerceService, sql: PoolClient, e: Exchange) {
  const offer=currentOffer(e),buyer=await commerce.repository.privateInput(e,e.buyerId,sql),seller=await commerce.repository.privateInput(e,e.sellerId,sql);
  const shipping=seller.connectedShipping?.[String(offer.version)];
  if(e.payment!=='paid' || e.cancellationRequested || e.returnPlan || e.sellerDroppedAt || e.carrierAcceptedAt
    || !['none','label_pending'].includes(e.shipping) || !offer.connectedShipping || !shipping
    || shipping.offerDigest!==digest(offer) || shipping.authorizationId!==offer.connectedShipping.authorizationId
    || e.mode!=='live' || e.mode!==commerce.mode || !commerce.connectedShippingEnabled
    || e.approvals.length!==2 || ![e.buyerId,e.sellerId].every(id=>e.approvals.some(a=>digest(a)===digest(approvalFor(e,id))))
    || buyer.addressVersion!==offer.quote.destinationVersion || seller.addressVersion!==offer.quote.originVersion
    || seller.packingVersion!==offer.quote.packingVersion || digest(e.item)!==digest(offer.item)) {
    conflict('Renewal requires the unchanged paid sale, both original approvals, and no physical handoff or return.');
  }
  const connection=(await sql.query<{id:string;generation:string;endpoint:string;inspection:unknown}>(`select id,generation,endpoint,inspection
    from pilot_connections where id=$1 and owner_id=$2 and exchange_id=$3 and mode=$4 and endpoint=$5
    and state='connected' and access_expires_at>now() for update`,[shipping.connectionId,e.sellerId,e.id,e.mode,shipping.endpoint])).rows[0];
  if(!connection) conflict('Reconnect and inspect the original seller shipping service before renewing postage.');
  const operations=(await sql.query<{id:string;kind:string;version:number;state:string;provider_id:string|null;result:{effectStarted?:boolean}|null}>(
    'select id,kind,version,state,provider_id,result from pilot_operations where exchange_id=$1 for update',[e.id])).rows;
  const labels=operations.filter(op=>op.kind==='label');
  if(operations.some(op=>['refund','cancel_checkout','label_refund','return_label'].includes(op.kind)) || labels.length!==1
    || labels[0]!.version!==offer.version || !['failed','uncertain'].includes(labels[0]!.state)
    || labels[0]!.provider_id || labels[0]!.result?.effectStarted
    || Object.keys(e.operationIssues ?? {}).some(id=>id!==labels[0]!.id)) {
    conflict('Only an undispatched postage operation needing attention can be renewed. Reconcile any possible purchase or refund first.');
  }
  return {offer,shipping,connection,operationId:labels[0]!.id};
}

export async function proposePostageRenewal(commerce:CommerceService,sql:PoolClient,e:Exchange,now:Date) {
  const {offer,shipping,connection,operationId}=await postageRenewalContext(commerce,sql,e);
  const expiresAt=new Date(Math.min(now.getTime()+2*3600_000,Date.parse(shipping.purchaseBefore)-60_000,Date.parse(offer.shipBy))).toISOString();
  if(Date.parse(expiresAt)<=now.getTime()+10*60_000) conflict('The original rate or ship-by deadline is too close. Refund and prepare a new sale instead.');
  return {expiresAt,amount:offer.quote.shippingAmount,
    postageRenewal:{authorizationId:shipping.authorizationId,accessDigest:postageAccessDigest(connection),operationId}};
}

export async function approvePostageRenewal(commerce:CommerceService,sql:PoolClient,e:Exchange) {
  const {connection,operationId}=await postageRenewalContext(commerce,sql,e);
  const renewal=e.resolution?.postageRenewal;
  if(!renewal || renewal.operationId!==operationId || renewal.accessDigest!==postageAccessDigest(connection)) {
    conflict('The service access or postage operation changed. Propose and review renewal again.');
  }
  if(e.resolution!.approvedBy.length===2) {
    await sql.query("update pilot_operations set state='pending',attempts=0,updated_at=now() where id=$1",[operationId]);
    if(e.operationIssues) delete e.operationIssues[operationId];
    e.problem=null;e.shipping='label_pending';e.stage='fulfilling';
  }
}
