import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { conflict,digest,exchangeView,requireRole,type Dropoff } from './domain.js';
import type { CommerceService } from './service.js';
import type { ServiceActionRow } from './service-actions.js';
import { checkedShippingOption,checkShippingOption } from './shipping-option.js';
import { ratedShippingSource } from './shipping-rates.js';
import { supportedDropoffSource,verifyPublicDropoff } from './public-dropoff.js';

export const verifyDropoffSchema=z.object({action:z.literal('verify_dropoff'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),carrierActionId:z.uuid(),researchId:z.uuid(),sourceId:z.uuid()}).strict();
type Input=z.infer<typeof verifyDropoffSchema>;
export interface VerifiedDropoff {
  id:string; carrierActionId:string; researchId:string; sourceId:string; sourceUrl:string;
  binding:string; expiresAt:string; dropoff:Dropoff;
}
/** Caller locks exchange before connection. IDs select server-owned evidence;
 * neither URL, carrier facts nor private addresses can be supplied by a model. */
async function context(commerce:CommerceService,sql:PoolClient,actor:string,input:Input) {
  const e=await commerce.repository.get(input.exchangeId,actor,sql,true);
  exchangeView(e,actor);requireRole(e,actor,'seller');
  if(e.mode!==commerce.mode || e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
  const row=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions
    where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4`,[input.carrierActionId,e.id,actor,e.mode])).rows[0];
  if(!row) conflict('Complete the selected carrier account check first.');
  const option=checkedShippingOption(row),carrier=await checkShippingOption(commerce,sql,row);
  if(option.carrierAccountId!==carrier.carrierAccountId) conflict('The selected carrier account changed.');
  const connection=(await sql.query<{access_expires_at:Date|null}>(
    'select access_expires_at from pilot_connections where id=$1',[row.connection_id])).rows[0];
  if(!connection?.access_expires_at || connection.access_expires_at.getTime()<=Date.now()) {
    conflict('Recheck the connected service access before selecting a location.');
  }
  const rates=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where id=$1',[option.sourceActionId])).rows[0]!;
  const rate=ratedShippingSource(rates).shipment.rates.find(rate=>rate.rateId===option.rateId)!;
  const mine=await commerce.repository.privateInput(e,actor,sql);
  const research=(await sql.query<{input:{addressVersion:number};result:{sources:Array<{id:string;url:string}>}}>(`select input,result
    from pilot_research where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4 and state='ready'`,
    [input.researchId,e.id,actor,e.mode])).rows[0];
  const source=research?.result?.sources.find(source=>source.id===input.sourceId);
  if(!mine.discoveryPostcode || research?.input.addressVersion!==(mine.discoveryVersion ?? 0)
    || !source || !supportedDropoffSource(source.url)) conflict('Choose an observed official location from research for your current discovery area.');
  if(!mine.packing?.canPrint || option.carrierToken!=='fedex' || rate.serviceToken!=='fedex_ground') {
    conflict('This verifier supports FedEx Ground with a printed label. Research another compatible path when needed.');
  }
  const expiresAt=new Date(Math.min(Date.parse(rate.expiresAt),Date.parse(e.shippingData!.expiresAt))).toISOString();
  const binding=digest({exchangeId:e.id,mode:e.mode,actor,carrierActionId:row.id,option,rate,
    connectionId:row.connection_id,generation:row.generation,endpoint:row.endpoint,consent:e.shippingData,
    discoveryVersion:mine.discoveryVersion ?? 0,researchId:input.researchId,sourceId:input.sourceId,sourceUrl:source.url});
  return {e,mine,binding,expiresAt,row,rate,rates,option,request:{sourceUrl:source.url,carrierToken:option.carrierToken,serviceToken:rate.serviceToken,packing:mine.packing}};
}
export async function requireVerifiedDropoff(commerce:CommerceService,sql:PoolClient,actor:string,exchangeId:string,revision:number,id:string) {
  const e=await commerce.repository.get(exchangeId,actor,sql,true);
  const record=(await commerce.repository.privateInput(e,actor,sql)).verifiedDropoff;
  if(!record || record.id!==id || Date.parse(record.expiresAt)<=Date.now()) conflict('Verify a current compatible drop-off first.');
  const checked=await context(commerce,sql,actor,{action:'verify_dropoff',exchangeId,revision,
    carrierActionId:record.carrierActionId,researchId:record.researchId,sourceId:record.sourceId});
  if(checked.binding!==record.binding) conflict('The drop-off evidence changed. Verify it again.');
  return {...checked,record};
}
function view(record:VerifiedDropoff,current:boolean) {
  return {id:record.id,carrierActionId:record.carrierActionId,sourceUrl:record.sourceUrl,expiresAt:record.expiresAt,
    dropoff:record.dropoff,state:current?'current' as const:'stale' as const,
    scope:'location_compatibility_only' as const};
}
export async function verifyDropoff(commerce:CommerceService,actor:string,raw:unknown,verify=verifyPublicDropoff) {
  commerce.authorize(actor);const input=verifyDropoffSchema.parse(raw);
  const before=await commerce.repository.transaction(sql=>context(commerce,sql,actor,input));
  const existing=before.mine.verifiedDropoff;
  if(existing?.binding===before.binding && Date.parse(existing.expiresAt)>Date.now()) return view(existing,true);
  // No DB locks across network I/O. Public documents receive no private forms.
  const dropoff=await verify(before.request);
  return commerce.repository.transaction(async sql=>{
    const after=await context(commerce,sql,actor,input);
    if(after.binding!==before.binding) conflict('Shipping details changed during location verification. Try again from current state.');
    const duplicate=after.mine.verifiedDropoff;
    if(duplicate?.binding===after.binding && Date.parse(duplicate.expiresAt)>Date.now()) return view(duplicate,true);
    const record:VerifiedDropoff={id:randomUUID(),carrierActionId:input.carrierActionId,researchId:input.researchId,sourceId:input.sourceId,
      sourceUrl:after.request.sourceUrl,binding:after.binding,expiresAt:new Date(Math.min(Date.parse(after.expiresAt),Date.now()+30*60_000)).toISOString(),dropoff};
    await commerce.repository.savePrivate(sql,after.e,actor,{...after.mine,verifiedDropoff:record});
    await commerce.repository.event(sql,after.e,actor,'dropoff_verified',{id:record.id,carrierActionId:record.carrierActionId,sourceUrl:record.sourceUrl,expiresAt:record.expiresAt});
    return view(record,true);
  });
}
/** Presentation rechecks current consent, connection, form versions and rate.
 * Stale public facts may be displayed, but can never authorize fulfillment. */
export async function verifiedDropoffView(commerce:CommerceService,actor:string,exchangeId:string) {
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(exchangeId,actor,sql,true);
    if(actor!==e.sellerId || e.mode!==commerce.mode) return null;
    const record=(await commerce.repository.privateInput(e,actor,sql)).verifiedDropoff;
    if(!record) return null;
    let current=false;
    try {
      const checked=await context(commerce,sql,actor,{action:'verify_dropoff',exchangeId,revision:e.revision,
        carrierActionId:record.carrierActionId,researchId:record.researchId,sourceId:record.sourceId});
      current=checked.binding===record.binding && Date.parse(record.expiresAt)>Date.now();
    } catch(error) { if(!(error instanceof AppError)) throw error; }
    return view(record,current);
  });
}
