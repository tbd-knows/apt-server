import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { conflict,digest,exchangeView,mutable,offerSettlement,requireRole,type Exchange,type Offer } from './domain.js';
import type { CommerceService } from './service.js';
import { requireVerifiedDropoff } from './verified-dropoff.js';
import { ratedShippingSource } from './shipping-rates.js';

export interface OfferEconomics {taxAmount:number;taxTreatment:string;subsidy:string}
export interface ConnectedShipping {
  authorizationId:string; connectionId:string; generation:string; endpoint:string; accountOwner:string;
  carrierToken:string; parcelId:string; qrRequested:boolean; rateActionId:string; carrierActionId:string;
  dropoffId:string; sourceBinding:string; purchaseBefore:string; offerDigest:string;
}
export interface ConnectedOfferDraft {
  id:string;turnId:string;revision:number;digest:string;expiresAt:string;offer:Offer;shipping:ConnectedShipping;
}
export const connectedOfferSchema=z.object({action:z.literal('prepare_connected_offer'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),dropoffId:z.uuid()}).strict();
export function connectedOfferExpiry(purchaseBefore:string,exchangeExpiresAt:string,now=Date.now()) {
  const expires=Math.min(now+2*3_600_000,Date.parse(purchaseBefore)-60_000,Date.parse(exchangeExpiresAt));
  // Reserve five minutes after Checkout for payment reconciliation and label
  // dispatch, plus time to share/approve before Stripe's minimum session length.
  if(!Number.isFinite(expires) || expires<=now+40*60_000) conflict('The selected rate is too close to its purchase deadline. Request fresh rates.');
  return new Date(expires).toISOString();
}
function economics(commerce:CommerceService) {
  const parsed=z.object({taxAmount:z.number().int().min(0).max(1_000_000),taxTreatment:z.string().trim().min(1).max(1000),
    subsidy:z.string().trim().min(1).max(1000)}).safeParse(commerce.offerEconomics);
  if(!parsed.success) throw new AppError('PROVIDER_NOT_READY','Confirm the pilot tax treatment and fee subsidy before preparing an offer.');
  return {...parsed.data,feeAmount:0,postageFunding:'seller_reimbursed' as const};
}
export function connectedOfferDraftView(draft:ConnectedOfferDraft|undefined,revision:number,now=new Date(),evidenceCurrent=true) {
  return draft ? {id:draft.id,digest:draft.digest,revision:draft.revision,expiresAt:draft.expiresAt,offer:draft.offer,
    settlement:offerSettlement(draft.offer),state:evidenceCurrent && draft.revision===revision && Date.parse(draft.expiresAt)>now.getTime()?'review':'stale'} : null;
}
/** Exact sale approvals grant separate fulfillment authority; the earlier free
 * lookup consent is not extended or reused to authorize a postage purchase. */
export async function requireConnectedOffer(commerce:CommerceService,sql:PoolClient,e:Exchange,offer:Offer,purpose:'spend'|'reconcile'='spend') {
  const shipping=(await commerce.repository.privateInput(e,e.sellerId,sql)).connectedShipping?.[String(offer.version)];
  if(!shipping || !offer.connectedShipping || offer.postageFunding!=='seller_reimbursed'
    || offer.connectedShipping.authorizationId!==shipping.authorizationId || shipping.offerDigest!==digest(offer)
    || offer.connectedShipping.endpoint!==shipping.endpoint || offer.connectedShipping.providerMode!=='live'
    || e.mode!==commerce.mode || (purpose==='spend' && Date.parse(offer.expiresAt)<=Date.now())) conflict('The connected shipping authorization is missing, changed or expired.');
  const connection=(await sql.query<{id:string}>(`select id from pilot_connections where id=$1 and owner_id=$2 and exchange_id=$3
    and mode=$4 and ($7::boolean or generation=$5) and endpoint=$6 and state='connected' and access_expires_at>now() for update`,
    [shipping.connectionId,e.sellerId,e.id,e.mode,shipping.generation,shipping.endpoint,purpose==='reconcile'])).rows[0];
  const buyer=await commerce.repository.privateInput(e,e.buyerId,sql),seller=await commerce.repository.privateInput(e,e.sellerId,sql);
  if(!connection || (purpose==='spend' && (buyer.addressVersion!==offer.quote.destinationVersion || seller.addressVersion!==offer.quote.originVersion
    || seller.packingVersion!==offer.quote.packingVersion || digest(e.item)!==digest(offer.item)))) {
    conflict('The connected shipping account, item or private shipping details changed. Prepare a new offer.');
  }
  return shipping;
}
/** The model chooses evidence IDs only. The resulting exact offer is private
 * until the seller explicitly shares it; sharing is not sale/postage approval. */
export async function prepareConnectedOffer(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=connectedOfferSchema.parse(raw);
  return commerce.repository.transaction(async sql=>{
  const e=await commerce.repository.get(input.exchangeId,actor,sql,true);exchangeView(e,actor);requireRole(e,actor,'seller');mutable(e,new Date());
    if(e.mode!==commerce.mode || e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
    if(Object.keys(e.operationIssues ?? {}).length) conflict('Resolve the outstanding provider operation before preparing a connected offer.');
    const mine=await commerce.repository.privateInput(e,actor,sql),previous=mine.connectedOfferDraft;
    if(previous?.turnId===turnId) {
      if(previous.shipping.dropoffId!==input.dropoffId) conflict('Review the offer already prepared in this turn.');
      return connectedOfferDraftView(previous,e.revision);
    }
    const checked=await requireVerifiedDropoff(commerce,sql,actor,e.id,e.revision,input.dropoffId);
    if(!e.item || !e.requestShared) conflict('Confirm and share the item before preparing its offer.');
    const source=ratedShippingSource(checked.rates),rate=checked.rate,terms=economics(commerce);
    if(!rate.purchaseBefore) conflict('Refresh the shipping rate to establish its provider purchase deadline.');
    // Review freshness is distinct from the provider's maximum rate age. Keep
    // the offer within two hours, with a margin before the provider deadline.
    const now=Date.now(),expiresAt=connectedOfferExpiry(rate.purchaseBefore,e.expiresAt,now);
    const fingerprint=digest({source:checked.binding,item:e.item,terms});
    if(previous && previous.shipping.sourceBinding===fingerprint && previous.revision===e.revision
      && Date.parse(previous.expiresAt)>now) return connectedOfferDraftView(previous,e.revision);
    const authorizationId=randomUUID();
    const offer:Offer={version:e.offers.length+1,item:structuredClone(e.item),...terms,currency:'USD',
      buyerTotal:e.item.sellerAmount+rate.amount+terms.taxAmount,expiresAt,shipBy:new Date(now+3*86_400_000).toISOString(),
      connectedShipping:{authorizationId,provider:'shippo',endpoint:checked.row.endpoint,providerMode:'live',accountOwnerRole:'seller'},
      quote:{shipmentId:source.shipment.shipmentId,rateId:rate.rateId,carrierAccountId:rate.carrierAccountId,carrier:rate.carrierName,
        service:rate.serviceToken,shippingAmount:rate.amount,currency:'USD',estimatedDays:rate.estimatedDays,expiresAt,
        originVersion:e.shippingData!.originVersion,destinationVersion:e.shippingData!.destinationVersion,packingVersion:e.shippingData!.packingVersion,
        artifact:checked.record.dropoff.artifact,dropoff:checked.record.dropoff}};
    offerSettlement(offer);
    const shipping:ConnectedShipping={authorizationId,connectionId:checked.row.connection_id,generation:checked.row.generation,
      endpoint:checked.row.endpoint,accountOwner:source.accountOwner,carrierToken:checked.option.carrierToken,
      parcelId:source.shipment.parcelId,qrRequested:source.shipment.qrRequested,rateActionId:checked.rates.id,carrierActionId:checked.row.id,
      dropoffId:checked.record.id,sourceBinding:fingerprint,purchaseBefore:rate.purchaseBefore,offerDigest:digest(offer)};
    const id=randomUUID(),reviewExpiresAt=new Date(Math.min(Date.parse(checked.record.expiresAt),now+15*60_000)).toISOString();
    const draft:ConnectedOfferDraft={id,turnId,revision:e.revision,offer,shipping,expiresAt:reviewExpiresAt,
      digest:digest({id,actor,exchangeId:e.id,mode:e.mode,revision:e.revision,offer,shipping,expiresAt:reviewExpiresAt})};
    await commerce.repository.savePrivate(sql,e,actor,{...mine,connectedOfferDraft:draft});
    await commerce.repository.message(sql,e,actor,actor,'status',{action:'review_connected_offer',draftId:id});
    return connectedOfferDraftView(draft,e.revision);
  });
}
/** Called only from authenticated human commands under the exchange lock. */
export async function shareConnectedOffer(commerce:CommerceService,sql:PoolClient,e:Exchange,actor:string,draftId:string,draftDigest:string) {
  requireRole(e,actor,'seller');mutable(e,new Date());
  if(Object.keys(e.operationIssues ?? {}).length) conflict('Resolve the outstanding provider operation before sharing a connected offer.');
  const mine=await commerce.repository.privateInput(e,actor,sql),draft=mine.connectedOfferDraft;
  if(!draft || draft.id!==draftId || draft.digest!==draftDigest || draft.revision!==e.revision || Date.parse(draft.expiresAt)<=Date.now()) {
    conflict('The prepared offer changed or expired. Ask your agent to prepare it again.');
  }
  const checked=await requireVerifiedDropoff(commerce,sql,actor,e.id,e.revision,draft.shipping.dropoffId);
  if(draft.shipping.sourceBinding!==digest({source:checked.binding,item:e.item,terms:economics(commerce)})
    || draft.offer.version!==e.offers.length+1 || draft.shipping.offerDigest!==digest(draft.offer)) conflict('The offer evidence or terms changed. Prepare it again.');
  const pendingQuote=await sql.query("select id from pilot_operations where exchange_id=$1 and kind='quote' and state in ('pending','running','uncertain')",[e.id]);
  if(pendingQuote.rowCount) conflict('Resolve the existing quote operation before sharing this connected offer.');
  e.offers.push(draft.offer);e.approvals=[];e.stage='offered';
  mine.connectedShipping ??={};mine.connectedShipping[String(draft.offer.version)]=draft.shipping;
  delete mine.connectedOfferDraft;
  await commerce.repository.savePrivate(sql,e,actor,mine);
  for(const recipient of [e.buyerId,e.sellerId]) await commerce.repository.message(sql,e,actor,recipient,'offer',draft.offer);
}
