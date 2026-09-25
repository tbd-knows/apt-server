import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { conflict,digest,exchangeView,requireRole,type Exchange } from './domain.js';
import type { CommerceService } from './service.js';
import { serviceActionView,wakeServiceAction,expireServiceReviews,type ServiceActionRow } from './service-actions.js';
import type { ServiceInvocation,ServiceResult } from './mcp-execution.js';
import { requireShippingDataConsent } from './shipping-consent.js';
import { requireShippoDescription,requireShippoWrapper } from './shipping-validation.js';
import { shippoPayload,shippoShipment,shippoShipmentArguments,type ShippoShipmentBinding } from './shippo-evidence.js';

export const shippingRatesSchema=z.object({action:z.literal('prepare_shipping_rates'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),connectionId:z.uuid(),consentId:z.uuid(),descriptionActionId:z.uuid(),
  sourceActionId:z.uuid().optional()}).strict();
const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const rate=z.object({rateId:id,shipmentId:id,carrierAccountId:id,carrierName:z.string().min(1).max(120),
  serviceToken:id,serviceName:z.string().min(1).max(200),amount:z.number().int().min(0).max(1_000_000),
  currency:z.literal('USD'),estimatedDays:z.number().int().min(0).max(365).nullable(),expiresAt:z.iso.datetime({offset:true}),
  purchaseBefore:z.iso.datetime({offset:true}).optional()});
const evidence=z.discriminatedUnion('state',[
  z.object({state:z.literal('rated'),shipmentId:id,parcelId:id,rates:z.array(rate).min(1).max(100),qrRequested:z.boolean()}),
  z.object({state:z.enum(['pending','error']),shipmentId:id}),
]);
const storedEvidence=z.object({providerMode:z.literal('live'),accountOwner:z.string().min(1).max(320),shipment:evidence});

/** Explicit allowlist; even malformed stored receipts cannot echo addresses,
 * account emails, signed artifacts or raw provider output to either model. */
export function shippingRatesResultView(result:ServiceActionRow['result']):ServiceActionRow['result'] {
  const parsed=storedEvidence.safeParse(result?.structuredContent?.shippingRates);
  return parsed.success ? {text:[],omittedContentTypes:[],structuredContent:{shippingRates:{providerMode:'live',shipment:parsed.data.shipment}}} : null;
}
/** Server-only source for a selected option. Never accept this record from a model. */
export function ratedShippingSource(row:ServiceActionRow) {
  const parsed=storedEvidence.safeParse(row.result?.structuredContent?.shippingRates);
  if(row.state!=='returned' || !row.invocation.shippingRates || !parsed.success || parsed.data.shipment.state!=='rated') {
    conflict('Choose a rate from a verified completed lookup.');
  }
  return {...parsed.data,shipment:parsed.data.shipment};
}
export function shippingRatesReceipt(receipt:ServiceResult,binding:ShippoShipmentBinding,expectedShipmentId?:string) {
  // The initial account identity comes from this connection's authenticated
  // response, never model input. Subsequent retrieval pins that identity.
  const account=z.object({object_owner:z.string().min(1).max(320)}).parse(shippoPayload(receipt)).object_owner;
  if(binding.accountOwner && binding.accountOwner!==account) conflict('The shipping service account changed.');
  const shipment=shippoShipment(receipt,{...binding,accountOwner:account},new Date(),expectedShipmentId);
  // Provider display fields are untrusted too. Reject reflected private form
  // values even when the provider places them inside a valid rate-name field.
  const projected=JSON.stringify(shipment.state==='rated' ? shipment.rates.map(rate=>[rate.carrierName,rate.serviceName]) : []).replace(/\s+/g,' ').toLowerCase();
  const privateValues=[account,...[binding.origin,binding.destination].flatMap(address=>
    [address.name,address.street1,address.street2,address.phone])];
  if(privateValues.some(value=>value.trim().length>=4 && projected.includes(JSON.stringify(value.trim().replace(/\s+/g,' ')).slice(1,-1).toLowerCase()))) {
    conflict('The shipping service response contains private input in a public field.');
  }
  return {text:[],omittedContentTypes:[],structuredContent:{shippingRates:{providerMode:'live' as const,accountOwner:account,shipment}}};
}
export function requireShippingRatesContract(endpoint:string,invocation:ServiceInvocation) {
  const context=invocation.shippingRates;
  if(!context || invocation.shippingValidation) conflict('Unsupported shipping rate operation.');
  requireShippoWrapper(endpoint,invocation,context.sourceActionId?'read':'write',context.sourceActionId?'GetShipment':'CreateShipment');
  // The complete body is reconstructed from approved private inputs before
  // preparation AND dispatch, not validated against provider-controlled prose.
}
async function sourceAction(sql:PoolClient,row:ServiceActionRow) {
  const context=row.invocation.shippingRates!;
  if(!context.sourceActionId) return;
  const source=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and exchange_id=$2 and owner_id=$3
    and connection_id=$4 and mode=$5 and generation=$6`,[context.sourceActionId,row.exchange_id,row.owner_id,row.connection_id,row.mode,row.generation])).rows[0];
  const stored=storedEvidence.safeParse(source?.result?.structuredContent?.shippingRates);
  if(!source || source.state!=='returned' || source.invocation.shippingRates?.consentId!==context.consentId
    || source.invocation.shippingRates.operationId!==context.operationId || !stored.success || stored.data.shipment.state!=='pending') {
    conflict('Retrieve only a pending shipment proven by this connection.');
  }
  return stored.data;
}
async function requireValidatedAddresses(sql:PoolClient,e:Exchange,connectionId:string,consentId:string) {
  const rows=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where exchange_id=$1 and owner_id=$2
    and connection_id=$3 and mode=$4 and generation=$5 and state='returned' order by created_at desc`,
    [e.id,e.sellerId,connectionId,e.mode,e.shippingData!.generation])).rows;
  for(const owner of [e.buyerId,e.sellerId]) {
    const row=rows.find(row=>row.invocation.shippingValidation?.consentId===consentId
      && row.invocation.shippingValidation.addressOwnerId===owner);
    if(!row || row.invocation.shippingValidation!.addressVersion!==(owner===e.buyerId?e.shippingData!.destinationVersion:e.shippingData!.originVersion)
      || row.result?.structuredContent?.addressValidation!=='valid') conflict('Validate both current private addresses before requesting rates.');
  }
}
/** Caller holds the exchange lock. Returns private provider binding only. */
export async function checkShippingRates(commerce:CommerceService,sql:PoolClient,row:ServiceActionRow) {
  requireShippingRatesContract(row.endpoint,row.invocation);
  const context=row.invocation.shippingRates!;
  const e=await commerce.repository.get(row.exchange_id,row.owner_id,sql,true);requireRole(e,row.owner_id,'seller');
  const inputs=await requireShippingDataConsent(commerce,sql,e,row.connection_id,context.consentId,new Date());
  await requireValidatedAddresses(sql,e,row.connection_id,context.consentId);
  const source=await sourceAction(sql,row);
  // Hosted Shippo MCP has no test account. Free lookup evidence always remains
  // live-provider evidence, even when the enclosing commerce exchange is test.
  const binding:ShippoShipmentBinding={...inputs,operationId:context.operationId,accountOwner:source?.accountOwner ?? '',mode:'live'};
  const expected=source ? {ShipmentId:source.shipment.shipmentId} : shippoShipmentArguments(binding);
  if(digest(row.invocation.arguments.arguments)!==digest(expected)) conflict('The approved rate lookup inputs changed.');
  return {binding,expectedShipmentId:source?.shipment.shipmentId};
}
export async function prepareShippingRates(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=shippingRatesSchema.parse(raw);
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(input.exchangeId,actor,sql,true);exchangeView(e,actor);requireRole(e,actor,'seller');
    if(e.mode!==commerce.mode || e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
    const inputs=await requireShippingDataConsent(commerce,sql,e,input.connectionId,input.consentId,new Date());
    const existing=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where owner_id=$1 and turn_id=$2',[actor,turnId])).rows[0];
    if(existing) {
      const context=existing.invocation.shippingRates;
      if(existing.exchange_id!==e.id || existing.connection_id!==input.connectionId || context?.consentId!==input.consentId
        || context.descriptionActionId!==input.descriptionActionId || context.sourceActionId!==input.sourceActionId) conflict('Review the service action already prepared in this turn.');
      return serviceActionView(existing);
    }
    const connection=(await sql.query<{inspection:{tools:ServiceInvocation['tool'][]};generation:string;endpoint:string}>(
      'select inspection,generation,endpoint from pilot_connections where id=$1',[input.connectionId])).rows[0]!;
    await expireServiceReviews(commerce,sql,e,actor,input.connectionId,connection.generation);
    const described=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and connection_id=$2 and owner_id=$3
      and exchange_id=$4 and mode=$5 and generation=$6`,[input.descriptionActionId,input.connectionId,actor,e.id,e.mode,connection.generation])).rows[0];
    if(!described) conflict('Describe the connected service operation first.');
    const operation=input.sourceActionId?'GetShipment':'CreateShipment',kind=input.sourceActionId?'read':'write';
    requireShippoDescription(described,operation,kind,input.sourceActionId ? {ShipmentId:'string'} :
      {address_from:'object',address_to:'object',parcels:'array',metadata:'string',async:'boolean',extra:'object'});
    const tool=connection.inspection?.tools.find(tool=>tool.name===`shippo_${kind}_execute_tool`);
    if(!tool) conflict('Inspect the service tools before requesting rates.');
    // One CreateShipment per exact disclosure, and one retrieval per source
    // receipt. Replays and uncertain creates cannot allocate new operations.
    const duplicate=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1
      and invocation->'shippingRates'->>'consentId'=$2 and coalesce(invocation->'shippingRates'->>'sourceActionId','')=$3
      and state not in ('declined','failed','expired') order by created_at desc limit 1`,[input.connectionId,input.consentId,input.sourceActionId ?? ''])).rows[0];
    if(duplicate) return serviceActionView(duplicate);
    if((await sql.query('select count(*)::int n from pilot_service_actions where exchange_id=$1 and owner_id=$2',[e.id,actor])).rows[0].n>=100) conflict('Review existing service actions before preparing more.');
    const id=randomUUID();
    let operationId:string=id;
    if(input.sourceActionId) {
      const source=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where id=$1',[input.sourceActionId])).rows[0];
      if(!source?.invocation.shippingRates) conflict('No pending shipment receipt.');
      operationId=source.invocation.shippingRates.operationId;
    }
    const invocation:ServiceInvocation={tool,arguments:{name:operation},shippingRates:{consentId:input.consentId,
      descriptionActionId:input.descriptionActionId,operationId,...(input.sourceActionId?{sourceActionId:input.sourceActionId}:{})}};
    const stub={id,exchange_id:e.id,owner_id:actor,connection_id:input.connectionId,mode:e.mode,generation:connection.generation,
      endpoint:connection.endpoint,invocation} as ServiceActionRow;
    const source=await sourceAction(sql,stub);
    invocation.arguments.arguments=source?{ShipmentId:source.shipment.shipmentId}:shippoShipmentArguments({...inputs,operationId,accountOwner:'',mode:'live'});
    await checkShippingRates(commerce,sql,stub);
    const expiresAt=new Date(Math.min(Date.now()+15*60_000,Date.parse(e.shippingData!.expiresAt)));
    const explanation=input.sourceActionId?'Retrieve the pending shipping rates from the connected service at no charge.'
      :'Compare shipping rates for the approved private addresses and packed box. This creates a shipment record in the live service account at no charge; it does not buy postage.';
    const binding=digest({id,actor,exchangeId:e.id,mode:e.mode,revision:e.revision,connectionId:input.connectionId,invocation,
      generation:connection.generation,endpoint:connection.endpoint,expiresAt:expiresAt.toISOString()});
    const row=(await sql.query<ServiceActionRow>(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,
      endpoint,invocation,explanation,digest,call_digest,state,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'review',$14) returning *`,
      [id,e.id,actor,input.connectionId,e.mode,turnId,e.revision,connection.generation,connection.endpoint,invocation,explanation,binding,
        digest({endpoint:connection.endpoint,invocation}),expiresAt])).rows[0]!;
    await wakeServiceAction(commerce,sql,row);return serviceActionView(row);
  });
}
