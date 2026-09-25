import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { conflict,digest,exchangeView,requireRole } from './domain.js';
import type { CommerceService } from './service.js';
import type { ServiceInvocation,ServiceResult } from './mcp-execution.js';
import { expireServiceReviews,serviceActionView,wakeServiceAction,type ServiceActionRow } from './service-actions.js';
import { requireShippingDataConsent } from './shipping-consent.js';
import { ratedShippingSource } from './shipping-rates.js';
import { requireShippoDescription,requireShippoWrapper } from './shipping-validation.js';
import { shippoCarrier } from './shippo-evidence.js';

const identifier=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const shippingOptionSchema=z.object({action:z.literal('prepare_shipping_option'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),rateActionId:z.uuid(),rateId:identifier,descriptionActionId:z.uuid()}).strict();
const optionEvidence=z.object({providerMode:z.literal('live'),rateId:identifier,carrierAccountId:identifier,
  carrierToken:identifier,sourceActionId:z.uuid()});
export function shippingOptionResultView(result:ServiceActionRow['result']):ServiceActionRow['result'] {
  const parsed=optionEvidence.safeParse(result?.structuredContent?.shippingOption);
  return parsed.success?{text:[],omittedContentTypes:[],structuredContent:{shippingOption:parsed.data}}:null;
}
/** No private address is sent to this read. Existing sharing authority and
 * rate freshness must still hold before promoting the selected option. */
export async function checkShippingOption(commerce:CommerceService,sql:PoolClient,row:ServiceActionRow) {
  const context=row.invocation.shippingOption;
  if(!context || row.invocation.shippingRates || row.invocation.shippingValidation) conflict('Unsupported carrier check.');
  requireShippoWrapper(row.endpoint,row.invocation,'read','GetCarrierAccount');
  const e=await commerce.repository.get(row.exchange_id,row.owner_id,sql,true);requireRole(e,row.owner_id,'seller');
  const source=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and exchange_id=$2
    and owner_id=$3 and connection_id=$4 and mode=$5 and generation=$6`,
    [context.rateActionId,e.id,row.owner_id,row.connection_id,e.mode,row.generation])).rows[0];
  if(!source) conflict('Choose a rate from this connected service.');
  const evidence=ratedShippingSource(source);
  await requireShippingDataConsent(commerce,sql,e,row.connection_id,source.invocation.shippingRates!.consentId,new Date());
  const rate=evidence.shipment.rates.find(rate=>rate.rateId===context.rateId);
  if(!rate || Date.parse(rate.expiresAt)<=Date.now()) conflict('The selected rate is missing or expired.');
  if(digest(row.invocation.arguments)!==digest({name:'GetCarrierAccount',arguments:{CarrierAccountId:rate.carrierAccountId}})) conflict('The carrier check differs from the selected rate.');
  return {accountOwner:evidence.accountOwner,carrierAccountId:rate.carrierAccountId,mode:'live' as const};
}
export function shippingOptionReceipt(receipt:ServiceResult,binding:Awaited<ReturnType<typeof checkShippingOption>>,context:NonNullable<ServiceInvocation['shippingOption']>) {
  const carrier=shippoCarrier(receipt,binding);
  return {text:[],omittedContentTypes:[],structuredContent:{shippingOption:{...carrier,providerMode:'live',rateId:context.rateId,sourceActionId:context.rateActionId}}};
}
export async function prepareShippingOption(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=shippingOptionSchema.parse(raw);
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(input.exchangeId,actor,sql,true);exchangeView(e,actor);requireRole(e,actor,'seller');
    if(e.mode!==commerce.mode || e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
    const source=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4`,
      [input.rateActionId,e.id,actor,e.mode])).rows[0];
    if(!source) conflict('Choose a rate from this connected service.');
    const rates=ratedShippingSource(source),rate=rates.shipment.rates.find(rate=>rate.rateId===input.rateId);
    if(!rate) conflict('Choose an actual returned rate.');
    await requireShippingDataConsent(commerce,sql,e,source.connection_id,source.invocation.shippingRates!.consentId,new Date());
    const existing=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where owner_id=$1 and turn_id=$2',[actor,turnId])).rows[0];
    const context={rateActionId:input.rateActionId,rateId:input.rateId,descriptionActionId:input.descriptionActionId};
    if(existing) {
      if(existing.exchange_id!==e.id || digest(existing.invocation.shippingOption ?? null)!==digest(context)) conflict('Review the action already prepared in this turn.');
      return serviceActionView(existing);
    }
    const connection=(await sql.query<{endpoint:string;generation:string;inspection:{tools:ServiceInvocation['tool'][]}}>(
      'select endpoint,generation,inspection from pilot_connections where id=$1',[source.connection_id])).rows[0]!;
    if(source.generation!==connection.generation) conflict('The shipping service connection changed.');
    await expireServiceReviews(commerce,sql,e,actor,source.connection_id,connection.generation);
    const description=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and exchange_id=$2 and owner_id=$3
      and connection_id=$4 and mode=$5 and generation=$6`,[input.descriptionActionId,e.id,actor,source.connection_id,e.mode,connection.generation])).rows[0];
    if(!description) conflict('Describe the carrier-account operation first.');
    requireShippoDescription(description,'GetCarrierAccount','read',{CarrierAccountId:'string'});
    const tool=connection.inspection?.tools.find(tool=>tool.name==='shippo_read_execute_tool');
    if(!tool) conflict('Inspect the service before checking a carrier account.');
    const invocation:ServiceInvocation={tool,arguments:{name:'GetCarrierAccount',arguments:{CarrierAccountId:rate.carrierAccountId}},shippingOption:context};
    const stub={exchange_id:e.id,owner_id:actor,connection_id:source.connection_id,generation:connection.generation,endpoint:connection.endpoint,invocation} as ServiceActionRow;
    await checkShippingOption(commerce,sql,stub);
    const callDigest=digest({endpoint:connection.endpoint,invocation});
    const duplicate=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1 and call_digest=$2
      and state not in ('declined','failed','expired') order by created_at desc limit 1`,[source.connection_id,callDigest])).rows[0];
    if(duplicate) return serviceActionView(duplicate);
    if((await sql.query('select count(*)::int n from pilot_service_actions where exchange_id=$1 and owner_id=$2',[e.id,actor])).rows[0].n>=100) conflict('Review existing service actions before preparing more.');
    const id=randomUUID(),expiresAt=new Date(Math.min(Date.parse(rate.expiresAt),Date.parse(e.shippingData!.expiresAt),Date.now()+15*60_000));
    const explanation=`Check that the carrier account behind ${rate.carrierName} ${rate.serviceName} is active. This is a free account lookup, not rate acceptance or postage purchase.`;
    const binding=digest({id,actor,exchangeId:e.id,mode:e.mode,revision:e.revision,connectionId:source.connection_id,
      generation:connection.generation,endpoint:connection.endpoint,invocation,expiresAt:expiresAt.toISOString()});
    const row=(await sql.query<ServiceActionRow>(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,
      endpoint,invocation,explanation,digest,call_digest,state,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'review',$14) returning *`,
      [id,e.id,actor,source.connection_id,e.mode,turnId,e.revision,connection.generation,connection.endpoint,invocation,explanation,binding,callDigest,expiresAt])).rows[0]!;
    await wakeServiceAction(commerce,sql,row);return serviceActionView(row);
  });
}
