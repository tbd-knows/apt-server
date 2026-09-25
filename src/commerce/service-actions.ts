import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { conflict,digest,exchangeView,type Exchange } from './domain.js';
import type { CommerceService } from './service.js';
import type { McpInspection } from './mcp-inspection.js';
import type { ServiceInvocation,ServiceResult } from './mcp-execution.js';
import { requireCapabilityDiscovery } from './service-policy.js';
import { shippingRatesResultView } from './shipping-rates.js';

export const serviceActionSchema=z.object({action:z.literal('prepare_service_action'),exchangeId:z.uuid(),connectionId:z.uuid(),
  revision:z.number().int().positive(),tool:z.string().min(1).max(128),arguments:z.record(z.string(),z.unknown()),
  explanation:z.string().trim().min(1).max(1000)}).strict();
export const serviceHistorySchema=z.object({action:z.literal('service_history'),exchangeId:z.uuid(),beforeActionId:z.uuid().optional()}).strict();
export interface ServiceActionRow {
  id:string;exchange_id:string;owner_id:string;connection_id:string;mode:string;turn_id:string;revision:number;generation:string;
  endpoint:string;invocation:ServiceInvocation;explanation:string;digest:string;call_digest:string;state:string;
  result:ServiceResult['result']|null;approved_at:Date|null;expires_at:Date;created_at:Date;updated_at:Date;
}
export const serviceActionView=(row:ServiceActionRow)=>({id:row.id,connectionId:row.connection_id,endpoint:row.endpoint,
  invocation:row.invocation.shippingRates ? {tool:{name:row.invocation.tool.name,description:'Compare approved shipping rates'},
    arguments:{operation:row.invocation.shippingRates.sourceActionId?'GetShipment':'CreateShipment',privateInput:'Resolved from approved private forms; omitted from this view'}} : row.invocation.shippingValidation ? {tool:{name:row.invocation.tool.name,description:'Validate an approved private shipping address'},
    arguments:{operation:'ValidateAddress',privateInput:'Resolved from the approved private form; omitted from agent and service-action projections'}} : row.invocation,
  explanation:row.explanation,digest:row.digest,state:row.state,
  result:row.invocation.shippingRates ? shippingRatesResultView(row.result) : row.invocation.shippingValidation ? validationResultView(row.result) : row.result,
  expiresAt:row.expires_at,updatedAt:row.updated_at,authority:'untrusted_service_result' as const,
  purpose:row.invocation.shippingRates ? 'free_shipping_rates' as const : row.invocation.shippingValidation ? 'free_address_validation' as const : 'capability_discovery_only' as const});
function validationResultView(result:ServiceActionRow['result']):ServiceActionRow['result'] {
  const status=result?.structuredContent?.addressValidation;
  return typeof status==='string' && ['valid','invalid','correction_required'].includes(status)
    ? {text:[],omittedContentTypes:[],structuredContent:{addressValidation:status}} : null;
}
export function activeServiceExchange(e:Exchange) {
  if(['cancelled','declined','expired','completed'].includes(e.stage) || e.cancellationRequested || e.problem) conflict('Resolve the exchange before using a service.');
  if(e.payment==='unpaid' && Date.parse(e.expiresAt)<=Date.now()) conflict('This exchange expired.');
}
export async function listServiceActions(commerce:CommerceService,actor:string,exchangeId:string) {
  commerce.authorize(actor);
  const e=await commerce.repository.get(exchangeId,actor);exchangeView(e,actor);
  if(e.mode!==commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
  return (await commerce.repository.pool.query<ServiceActionRow>('select * from pilot_service_actions where exchange_id=$1 and owner_id=$2 and mode=$3 order by created_at,id',[exchangeId,actor,commerce.mode])).rows.map(serviceActionView);
}
/** Resume older private receipts without expanding every model turn's context.
 * A cursor is an owned receipt reference, never a caller-supplied timestamp. */
export async function serviceActionHistory(commerce:CommerceService,actor:string,raw:unknown) {
  commerce.authorize(actor);const input=serviceHistorySchema.parse(raw);
  const e=await commerce.repository.get(input.exchangeId,actor);exchangeView(e,actor);
  if(e.mode!==commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
  const values:unknown[]=[e.id,actor,commerce.mode];
  let cursor='';
  if(input.beforeActionId) {
    const owned=(await commerce.repository.pool.query<ServiceActionRow>(`select * from pilot_service_actions
      where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4`,[input.beforeActionId,e.id,actor,commerce.mode])).rows[0];
    if(!owned) throw new AppError('NOT_FOUND','Service action not found.');
    // Preserve Postgres microseconds by comparing inside the database rather
    // than round-tripping created_at through JavaScript Date milliseconds.
    values.push(owned.id);
    cursor='and (created_at,id)<(select created_at,id from pilot_service_actions where id=$4)';
  }
  const rows=(await commerce.repository.pool.query<ServiceActionRow>(`select * from pilot_service_actions
    where exchange_id=$1 and owner_id=$2 and mode=$3 ${cursor} order by created_at desc,id desc limit 6`,values)).rows;
  const page=rows.slice(0,5);
  return {exchangeId:e.id,actions:page.map(serviceActionView),nextBeforeActionId:rows.length>5?page.at(-1)!.id:null,
    authority:'untrusted_service_result' as const};
}
export async function prepareServiceAction(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=serviceActionSchema.parse(raw);
  if(Buffer.byteLength(JSON.stringify(input.arguments))>24000) conflict('Service arguments are too large to review.');
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(input.exchangeId,actor,sql,true);exchangeView(e,actor);activeServiceExchange(e);
    if(e.mode!==commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
    const previous=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where owner_id=$1 and turn_id=$2',[actor,turnId])).rows[0];
    if(previous) {
      if(previous.exchange_id!==e.id || previous.connection_id!==input.connectionId || previous.invocation.tool.name!==input.tool
        || digest(previous.invocation.arguments)!==digest(input.arguments) || previous.explanation!==input.explanation) conflict('Review the service action already prepared in this turn.');
      return serviceActionView(previous);
    }
    if(e.revision!==input.revision) conflict('The exchange changed. Read the current state again.');
    const connection=(await sql.query<{endpoint:string;generation:string;inspection:McpInspection}>(`select endpoint,generation,inspection from pilot_connections
      where id=$1 and owner_id=$2 and exchange_id=$3 and mode=$4 and state='connected'`,[input.connectionId,actor,e.id,e.mode])).rows[0];
    const tool=connection?.inspection?.tools.find(tool=>tool.name===input.tool);
    if(!connection || !tool) conflict('Connect and inspect this service before preparing an action.');
    await expireServiceReviews(commerce,sql,e,actor,input.connectionId,connection.generation);
    const invocation={tool,arguments:input.arguments},callDigest=digest({endpoint:connection.endpoint,invocation});
    requireCapabilityDiscovery(connection.endpoint,invocation);
    const duplicate=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1 and call_digest=$2
      and state not in ('declined','failed','expired') order by created_at desc limit 1`,[input.connectionId,callDigest])).rows[0];
    if(duplicate) return serviceActionView(duplicate);
    const count=(await sql.query('select count(*)::int n from pilot_service_actions where exchange_id=$1 and owner_id=$2',[e.id,actor])).rows[0].n;
    if(count>=100) conflict('Review existing service actions before preparing more.');
    const id=randomUUID(),expiresAt=new Date(Date.now()+15*60_000);
    const binding=digest({id,actor,exchangeId:e.id,connectionId:input.connectionId,mode:e.mode,revision:e.revision,
      generation:connection.generation,endpoint:connection.endpoint,invocation,explanation:input.explanation,expiresAt:expiresAt.toISOString()});
    const row=(await sql.query<ServiceActionRow>(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,
      endpoint,invocation,explanation,digest,call_digest,state,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'review',$14) returning *`,
      [id,e.id,actor,input.connectionId,e.mode,turnId,e.revision,connection.generation,connection.endpoint,invocation,input.explanation,binding,callDigest,expiresAt])).rows[0]!;
    await wakeServiceAction(commerce,sql,row);
    return serviceActionView(row);
  });
}
export async function expireServiceReviews(commerce:CommerceService,sql:PoolClient,e:Exchange,actor:string,connectionId:string,generation:string) {
  const stale=(await sql.query<ServiceActionRow>(`update pilot_service_actions set state='expired',updated_at=now()
    where exchange_id=$1 and owner_id=$2 and state='review' and (revision<>$3 or expires_at<now()
      or (connection_id=$4 and generation<>$5)) returning *`,[e.id,actor,e.revision,connectionId,generation])).rows;
  for(const row of stale) await wakeServiceAction(commerce,sql,row);
}
export async function wakeServiceAction(commerce:CommerceService,sql:PoolClient,row:ServiceActionRow) {
  const e=await commerce.repository.get(row.exchange_id,row.owner_id,sql);
  await commerce.repository.message(sql,e,row.owner_id,row.owner_id,'status',{
    action:row.state==='review'?'review_service_action':'service_action_update',serviceActionId:row.id});
}
export async function recoverServiceActions(commerce:CommerceService) {
  await commerce.repository.transaction(async sql=>{
    const rows=(await sql.query<ServiceActionRow>(`update pilot_service_actions set state=case when state='running' then 'uncertain' else 'expired' end,updated_at=now()
      where mode=$1 and owner_id=any($2::uuid[]) and ((state='review' and expires_at<now()) or (state in ('verifying','running') and updated_at<now()-interval '90 seconds')) returning *`,[commerce.mode,commerce.founders])).rows;
    for(const row of rows) await wakeServiceAction(commerce,sql,row);
  });
}
