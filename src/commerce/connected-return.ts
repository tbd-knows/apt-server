import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { conflict,currentOffer,digest,requireRole,type Exchange,type Quote,type Offer } from './domain.js';
import type { CommerceService } from './service.js';
import { requireReturnPlanning } from './shipping-consent.js';
import { requireVerifiedDropoff } from './verified-dropoff.js';
import { ratedShippingSource } from './shipping-rates.js';
import type { ConnectedShipping } from './connected-offer.js';

export interface ConnectedReturnDraft {
  id:string;turnId:string;revision:number;digest:string;expiresAt:string;resolutionId:string;offerDigest:string;
  version:number;quote:Quote;shipping:ConnectedShipping;
}
export const connectedReturnSchema=z.object({action:z.literal('prepare_connected_return'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),dropoffId:z.uuid()}).strict();
export function connectedReturnDraftView(draft:ConnectedReturnDraft|undefined,revision:number,now=new Date(),evidenceCurrent=true) {
  return draft?{id:draft.id,digest:draft.digest,revision:draft.revision,expiresAt:draft.expiresAt,
    resolutionId:draft.resolutionId,version:draft.version,quote:draft.quote,funding:'seller_absorbed' as const,
    state:evidenceCurrent && draft.revision===revision && Date.parse(draft.expiresAt)>now.getTime()?'review':'stale'}:null;
}
async function context(commerce:CommerceService,sql:PoolClient,e:Exchange,actor:string,dropoffId:string) {
  requireRole(e,actor,'buyer');const plan=requireReturnPlanning(e),offer=currentOffer(e);
  if(!offer.connectedShipping || e.mode!==commerce.mode || e.shippingData?.journey!=='return') conflict('A connected return with fresh shipping permission is required.');
  const checked=await requireVerifiedDropoff(commerce,sql,actor,e.id,e.revision,dropoffId);
  const source=ratedShippingSource(checked.rates);
  if(!checked.rate.purchaseBefore) conflict('Refresh the return rate to establish its purchase deadline.');
  const previous=(await sql.query("select id from pilot_operations where exchange_id=$1 and kind in ('return_label','refund','label_refund') and coalesce(result->>'cancelledNoLabel','false')<>'true' and coalesce(result->>'returnCancelled','false')<>'true'",[e.id])).rowCount;
  if(previous) conflict('Reconcile the existing purchase or refund before changing the return option.');
  const sourceBinding=digest({source:checked.binding,resolutionId:plan.resolutionId,offer: digest(offer),returnVersion:plan.version+1});
  return {...checked,plan,offer,source,sourceBinding};
}
/** A private, exact quote for the buyer who will hand off the return. Preparation
 * and sharing disclose seller funding but never grant purchase authority. */
export async function prepareConnectedReturn(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=connectedReturnSchema.parse(raw);
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(input.exchangeId,actor,sql,true);
    if(e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
    const checked=await context(commerce,sql,e,actor,input.dropoffId),mine=checked.mine,previous=mine.connectedReturnDraft;
    if(previous?.turnId===turnId && previous.shipping.dropoffId!==input.dropoffId) conflict('Review the return option already prepared in this turn.');
    if(previous?.revision===e.revision && previous.shipping.sourceBinding===checked.sourceBinding && Date.parse(previous.expiresAt)>Date.now()) {
      return connectedReturnDraftView(previous,e.revision);
    }
    const {rate,row,option,source,plan,offer}=checked,now=Date.now();
    const quoteExpiry=Math.min(now+2*3600_000,Date.parse(rate.purchaseBefore!)-60_000);
    if(quoteExpiry<=now+10*60_000) conflict('The return rate is too close to its purchase deadline. Request fresh rates.');
    const quote:Quote={shipmentId:source.shipment.shipmentId,rateId:rate.rateId,carrierAccountId:rate.carrierAccountId,
      carrier:rate.carrierName,service:rate.serviceToken,shippingAmount:rate.amount,currency:'USD',estimatedDays:rate.estimatedDays,
      expiresAt:new Date(quoteExpiry).toISOString(),originVersion:e.shippingData!.originVersion,
      destinationVersion:e.shippingData!.destinationVersion,packingVersion:e.shippingData!.packingVersion,
      artifact:checked.record.dropoff.artifact,dropoff:checked.record.dropoff};
    const shipping:ConnectedShipping={authorizationId:randomUUID(),connectionId:row.connection_id,generation:row.generation,
      endpoint:row.endpoint,accountOwner:source.accountOwner,carrierToken:option.carrierToken,parcelId:source.shipment.parcelId,
      qrRequested:source.shipment.qrRequested,rateActionId:checked.rates.id,carrierActionId:row.id,dropoffId:checked.record.id,
      sourceBinding:checked.sourceBinding,purchaseBefore:rate.purchaseBefore!,offerDigest:digest(offer)};
    const terms={id:randomUUID(),turnId,revision:e.revision,expiresAt:new Date(Math.min(Date.parse(checked.record.expiresAt),now+15*60_000)).toISOString(),
      resolutionId:plan.resolutionId,offerDigest:digest(offer),version:plan.version+1,quote,shipping};
    const draft:ConnectedReturnDraft={...terms,digest:digest({actor,exchangeId:e.id,mode:e.mode,...terms})};
    await commerce.repository.savePrivate(sql,e,actor,{...mine,connectedReturnDraft:draft});
    await commerce.repository.message(sql,e,actor,actor,'status',{action:'review_connected_return',draftId:draft.id});
    return connectedReturnDraftView(draft,e.revision);
  });
}
export async function shareConnectedReturn(commerce:CommerceService,sql:PoolClient,e:Exchange,actor:string,id:string,binding:string) {
  requireRole(e,actor,'buyer');
  const mine=await commerce.repository.privateInput(e,actor,sql),draft=mine.connectedReturnDraft;
  if(!draft || draft.id!==id || draft.digest!==binding || draft.revision!==e.revision || Date.parse(draft.expiresAt)<=Date.now()) {
    conflict('The prepared return option changed or expired. Ask your agent to prepare it again.');
  }
  const checked=await context(commerce,sql,e,actor,draft.shipping.dropoffId);
  if(checked.sourceBinding!==draft.shipping.sourceBinding || draft.offerDigest!==digest(checked.offer)
    || draft.resolutionId!==checked.plan.resolutionId || draft.version!==checked.plan.version+1) conflict('The return evidence changed. Prepare it again.');
  checked.plan.quote=draft.quote;checked.plan.version=draft.version;checked.plan.approvals=[];
  checked.plan.subsidy='The seller pays and absorbs return postage through their connected shipping account. The buyer pays nothing extra. After carrier delivery and seller receipt, the original Stripe payment is refunded in full and the original seller transfer is reversed, including outbound postage reimbursement.';
  checked.plan.funding='seller_absorbed';
  // Private purchase evidence is separate from the shared quote. The
  // shared quote contains no account owner, credentials or signed artifact URL.
  mine.connectedReturn={version:draft.version,resolutionId:draft.resolutionId,termsDigest:returnTerms(checked.plan),shipping:draft.shipping};
  delete mine.connectedReturnDraft;
  await commerce.repository.savePrivate(sql,e,actor,mine);
  for(const recipient of [e.buyerId,e.sellerId]) await commerce.repository.message(sql,e,actor,recipient,'offer',
    {action:'return_option',version:draft.version,quote:draft.quote,funding:'seller_absorbed'});
}

/** Immutable private evidence binds the return quote separately from the paid sale. */
export function returnTerms(plan:NonNullable<Exchange['returnPlan']>) {
  return digest({version:plan.version,resolutionId:plan.resolutionId,quote:plan.quote,funding:plan.funding,subsidy:plan.subsidy});
}
export async function requireConnectedReturn(commerce:CommerceService,sql:PoolClient,e:Exchange,offer:Offer,purpose:'spend'|'reconcile'='spend') {
  const buyer=await commerce.repository.privateInput(e,e.buyerId,sql),bound=buyer.connectedReturn,plan=e.returnPlan;
  if(!bound || !plan?.quote || !offer.connectedShipping || plan.funding!=='seller_absorbed'
    || bound.version!==plan.version || bound.resolutionId!==plan.resolutionId || bound.termsDigest!==returnTerms(plan)
    || bound.shipping.offerDigest!==digest(offer) || digest(currentOffer(e))!==digest(offer) || e.mode!==commerce.mode
    || e.resolution?.id!==plan.resolutionId || e.resolution.remedy!=='return' || e.resolution.offerDigest!==digest(offer)
    || ![e.buyerId,e.sellerId].every(id=>e.resolution!.approvedBy.includes(id))) conflict('The connected return authorization changed.');
  const original=(await commerce.repository.privateInput(e,e.sellerId,sql)).connectedShipping?.[String(offer.version)];
  const shipping=bound.shipping;
  if(!original || shipping.connectionId!==original.connectionId || shipping.endpoint!==original.endpoint || shipping.accountOwner!==original.accountOwner) conflict('Return postage requires the original seller service account.');
  const connection=(await sql.query<{generation:string}>(`select generation from pilot_connections where id=$1 and owner_id=$2 and exchange_id=$3
    and mode=$4 and endpoint=$5 and state='connected' and access_expires_at>now() for update`,
    [shipping.connectionId,e.sellerId,e.id,e.mode,shipping.endpoint])).rows[0];
  if(!connection) conflict('Reconnect the original seller shipping account to reconcile the return.');
  if(purpose==='spend') {
    const seller=await commerce.repository.privateInput(e,e.sellerId,sql);
    if(connection.generation!==shipping.generation || Date.parse(plan.quote.expiresAt)<=Date.now()
      || Date.parse(shipping.purchaseBefore)<=Date.now() || buyer.addressVersion!==plan.quote.originVersion
      || seller.addressVersion!==plan.quote.destinationVersion || buyer.returnPackingVersion!==plan.quote.packingVersion
      || e.payment!=='paid') conflict('Return postage authority expired or the account, payment or private shipping details changed.');
  }
  return shipping;
}
