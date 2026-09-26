import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { conflict,digest,exchangeView,requireRole,type Address } from './domain.js';
import type { CommerceService } from './service.js';
import type { ServiceActionRow } from './service-actions.js';
import { serviceActionView,wakeServiceAction,expireServiceReviews } from './service-actions.js';
import { requireShippingDataConsent,shippingAddressVersion } from './shipping-consent.js';
import { shippoAddressArguments } from './shippo-evidence.js';
import type { ServiceInvocation } from './mcp-execution.js';
import { publicEndpoint } from './public-http.js';

export const shippingValidationSchema=z.object({action:z.literal('prepare_shipping_validation'),exchangeId:z.uuid(),
  revision:z.number().int().positive(),connectionId:z.uuid(),consentId:z.uuid(),descriptionActionId:z.uuid(),
  addressRole:z.enum(['buyer','seller'])}).strict();

/** Match the schema actually returned by authenticated discovery. Unknown
 * wrapper layouts are unavailable, never guessed from a model's prose. */
export function requireShippoWrapper(endpoint:string,invocation:ServiceInvocation,kind:'read'|'write',operation:string) {
  if(!publicEndpoint(endpoint)) conflict('Unsupported service endpoint.');
  const url=new URL(endpoint),schema=invocation.tool.inputSchema;
  const property=z.object({type:z.string()}).passthrough();
  const parsed=z.object({type:z.literal('object'),properties:z.object({name:property,arguments:property}).strict(),
    required:z.array(z.string()),additionalProperties:z.boolean().optional()}).passthrough().safeParse(schema);
  if(url.hostname!=='mcp.shippo.com' || !['/','/mcp'].includes(url.pathname)
    || invocation.tool.name!==`shippo_${kind}_execute_tool` || !parsed.success || parsed.data.properties.name.type!=='string'
    || parsed.data.properties.arguments.type!=='object' || digest([...parsed.data.required].sort())!==digest(['arguments','name'])
    || Object.keys(schema).some(key=>!['type','properties','required','additionalProperties','description','title','$schema'].includes(key))
    || digest(Object.keys(invocation.arguments).sort())!==digest(['arguments','name']) || invocation.arguments.name!==operation) {
    conflict('The inspected service does not expose the supported operation contract.');
  }
}
export function requireAddressValidationContract(endpoint:string,invocation:ServiceInvocation) {
  requireShippoWrapper(endpoint,invocation,'read','ValidateAddress');
  const argumentsSchema=z.object({address_line_1:z.string(),address_line_2:z.string(),city_locality:z.string(),
    state_province:z.string(),postal_code:z.string(),country_code:z.literal('US'),name:z.string()}).strict();
  if(!argumentsSchema.safeParse(invocation.arguments.arguments).success) conflict('Unsupported address validation arguments.');
}

/** Accept only an actual stored describe-tool receipt naming the operation.
 * Description prose and schemas cannot widen the independently verified policy.
 * Unsupported response representations fail closed for subsequent investigation. */
export function requireShippoDescription(row:ServiceActionRow,operation:string,kind:'read'|'write',fields:Record<string,string>) {
  const descriptor=z.object({name:z.literal(operation),kind:z.literal(kind),
    inputSchema:z.object({type:z.literal('object'),properties:z.record(z.string(),z.unknown()),required:z.array(z.string()).optional()}).passthrough()}).passthrough();
  if(row.state!=='returned' || row.invocation.tool.name!=='shippo_describe_tool' || !row.result || row.result.omittedContentTypes.length) {
    conflict('Describe the service operation first.');
  }
  const values:unknown[]=[];
  if(row.result.structuredContent) values.push(row.result.structuredContent);
  for(const text of row.result.text) {
    try {if(text.trim()) values.push(JSON.parse(text));} catch {conflict('The service operation description has an unsupported format.');}
  }
  if(!values.length || values.some(value=>digest(value)!==digest(values[0]))) conflict('The service operation description is ambiguous.');
  const result=descriptor.safeParse(values[0]);
  if(!result.success) conflict('The service operation description has an unsupported format.');
  const schema=result.data.inputSchema,allowed=Object.keys(fields);
  if((schema.required ?? []).some(key=>!allowed.includes(key)) || allowed.some(key=>
    !z.object({type:z.literal(fields[key]!)}).passthrough().safeParse(schema.properties[key]).success)) {
    conflict('The described operation inputs are not supported.');
  }
}

export function requireAddressDescription(row:ServiceActionRow) {
  const fields=Object.fromEntries(Object.keys(shippoAddressArguments({name:'Fixture',street1:'1 Main St',street2:'',city:'Boston',state:'MA',zip:'02110',country:'US',phone:'+16175550101'})).map(key=>[key,'string']));
  requireShippoDescription(row,'ValidateAddress','read',fields);
}

export async function prepareShippingValidation(commerce:CommerceService,actor:string,turnId:string,raw:unknown) {
  commerce.authorize(actor);const input=shippingValidationSchema.parse(raw);
  return commerce.repository.transaction(async sql=>{
    const e=await commerce.repository.get(input.exchangeId,actor,sql,true);exchangeView(e,actor);requireRole(e,actor,'seller');
    if(e.mode!==commerce.mode || e.revision!==input.revision) conflict('The exchange changed. Read its current state.');
    const addresses=await requireShippingDataConsent(commerce,sql,e,input.connectionId,input.consentId,new Date());
    const addressOwnerId=input.addressRole==='buyer'?e.buyerId:e.sellerId;
    const addressVersion=shippingAddressVersion(e,addressOwnerId);
    const existing=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where owner_id=$1 and turn_id=$2',[actor,turnId])).rows[0];
    if(existing) {
      const context=existing.invocation.shippingValidation;
      if(existing.exchange_id!==e.id || existing.connection_id!==input.connectionId || context?.consentId!==input.consentId
        || context.addressOwnerId!==addressOwnerId || context.descriptionActionId!==input.descriptionActionId) conflict('Review the service action already prepared in this turn.');
      return serviceActionView(existing);
    }
    const connection=(await sql.query<{inspection:{tools:ServiceInvocation['tool'][]};generation:string;endpoint:string}>(
      'select inspection,generation,endpoint from pilot_connections where id=$1',[input.connectionId])).rows[0]!;
    await expireServiceReviews(commerce,sql,e,actor,input.connectionId,connection.generation);
    const described=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where id=$1 and connection_id=$2 and owner_id=$3
      and exchange_id=$4 and mode=$5 and generation=$6`,[input.descriptionActionId,input.connectionId,actor,e.id,e.mode,connection.generation])).rows[0];
    if(!described) conflict('Describe the connected service operation first.');
    requireAddressDescription(described);
    const tool=connection.inspection?.tools.find(tool=>tool.name==='shippo_read_execute_tool');
    if(!tool) conflict('Inspect the service tools before requesting validation.');
    const isOrigin=addressOwnerId===(e.shippingData!.journey==='return'?e.buyerId:e.sellerId);
    const address:Address=isOrigin?addresses.origin:addresses.destination;
    const invocation:ServiceInvocation={tool,arguments:{name:'ValidateAddress',arguments:shippoAddressArguments(address)},
      shippingValidation:{consentId:input.consentId,addressOwnerId,addressVersion,descriptionActionId:input.descriptionActionId}};
    requireAddressValidationContract(connection.endpoint,invocation);
    const callDigest=digest({endpoint:connection.endpoint,invocation});
    const duplicate=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1 and call_digest=$2
      and state not in ('declined','failed','expired') order by created_at desc limit 1`,[input.connectionId,callDigest])).rows[0];
    if(duplicate) return serviceActionView(duplicate);
    if((await sql.query('select count(*)::int n from pilot_service_actions where exchange_id=$1 and owner_id=$2',[e.id,actor])).rows[0].n>=100) {
      conflict('Review existing service actions before preparing more.');
    }
    const id=randomUUID(),expiresAt=new Date(Math.min(Date.now()+15*60_000,Date.parse(e.shippingData!.expiresAt)));
    const explanation=`Validate the ${input.addressRole}'s approved private address. This lookup is free and does not create postage.`;
    const binding=digest({id,actor,exchangeId:e.id,mode:e.mode,connectionId:input.connectionId,invocation,generation:connection.generation,expiresAt:expiresAt.toISOString()});
    const row=(await sql.query<ServiceActionRow>(`insert into pilot_service_actions(id,exchange_id,owner_id,connection_id,mode,turn_id,revision,generation,
      endpoint,invocation,explanation,digest,call_digest,state,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'review',$14) returning *`,
      [id,e.id,actor,input.connectionId,e.mode,turnId,e.revision,connection.generation,connection.endpoint,invocation,explanation,binding,callDigest,expiresAt])).rows[0]!;
    await wakeServiceAction(commerce,sql,row);
    return serviceActionView(row);
  });
}
