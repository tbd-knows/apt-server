import type { PoolClient } from 'pg';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CommerceService } from './service.js';
import { requireConnectedReturn } from './connected-return.js';
import { requireConnectedOffer } from './connected-offer.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { conflict, digest, type Exchange, type Offer } from './domain.js';
import { executeMcp, type ServiceInvocation } from './mcp-execution.js';
import { publicEndpointFetch } from './public-http.js';
import { requireShippoDescription, requireShippoWrapper } from './shipping-validation.js';
import type { ServiceActionRow } from './service-actions.js';
import { shippoCarrier, shippoPayload, shippoRate, shippoRefund, shippoTracking, shippoTransaction } from './shippo-evidence.js';
import { ProviderFailure } from './providers.js';

export const connectedShippingContracts = {
  GetRate: { RateId: 'string' }, GetCarrierAccount: { CarrierAccountId: 'string' },
  GetTransaction: { TransactionId: 'string' }, GetTrack: { Carrier: 'string', TrackingNumber: 'string' },
  GetRefund: { RefundId: 'string' },
  CreateTransaction: { rate:'string',label_file_type:'string',metadata:'string',async:'boolean' },
  CreateRefund: { transaction:'string',async:'boolean' },
} as const;
export type ConnectedOperation = keyof typeof connectedShippingContracts;
interface Connection {
  id:string; owner_id:string; exchange_id:string; mode:string; endpoint:string; generation:string;
  credentials:string; inspection:{tools:ServiceInvocation['tool'][]};
}

export async function requireConnectedShippingLifecycle(commerce:CommerceService,sql:PoolClient,e:Exchange,offer:Offer,returning=false) {
  const shipping=await (returning?requireConnectedReturn:requireConnectedOffer)(commerce,sql,e,offer);
  const connection=(await sql.query<Connection>('select * from pilot_connections where id=$1',[shipping.connectionId])).rows[0]!;
  const rows=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1
    and owner_id=$2 and exchange_id=$3 and mode=$4 and generation=$5 and state='returned'
    and invocation->'tool'->>'name'='shippo_describe_tool'`,[connection.id,e.sellerId,e.id,e.mode,connection.generation])).rows;
  for(const [name,fields] of Object.entries(connectedShippingContracts)) {
    const kind=name.startsWith('Create')?'write':'read';
    if(!rows.some(row=>{try {requireShippoDescription(row,name,kind,fields);return true;} catch {return false;}})) {
      conflict(`Describe ${name} on the current service connection before payment.`);
    }
    const tool=connection.inspection?.tools.find(tool=>tool.name===`shippo_${kind}_execute_tool`);
    if(!tool) conflict('Reinspect the shipping service before payment.');
    requireShippoWrapper(connection.endpoint,{tool,arguments:{name,arguments:Object.fromEntries(
      Object.entries(fields).map(([field,type])=>[field,type==='boolean'?false:'schema_check']))}},kind,name);
  }
}

/** Read-only execution of an approved offer's known provider objects. No
 * arbitrary model arguments, new shipment creation, postage purchase or refund
 * submission is exposed here. Reauthorization permits canonical reads while
 * the original generation and expiry still fence any future spending. */
export class ConnectedShippingRead {
  private readonly secrets:ConnectionSecrets;
  constructor(protected readonly commerce:CommerceService,protected readonly rootSecret:string,protected readonly execute=executeMcp,protected readonly returning=false) {
    this.secrets=new ConnectionSecrets(rootSecret);
  }
  forReturn():ConnectedShippingRead {return new ConnectedShippingRead(this.commerce,this.rootSecret,this.execute,true);}
  protected quote(e:Exchange,offer:Offer) {
    if(this.returning && !e.returnPlan?.quote) conflict('A return quote is required.');
    return this.returning?e.returnPlan!.quote!:offer.quote;
  }
  protected version(e:Exchange,offer:Offer) {return this.returning?e.returnPlan!.version:offer.version;}
  protected authorize(sql:PoolClient,e:Exchange,offer:Offer,purpose:'spend'|'reconcile') {
    return this.returning?requireConnectedReturn(this.commerce,sql,e,offer,purpose):requireConnectedOffer(this.commerce,sql,e,offer,purpose);
  }
  async requireLifecycle(e:Exchange,offer:Offer) {
    await this.commerce.repository.transaction(async sql=>{
      const current=await this.commerce.repository.get(e.id,e.sellerId,sql,true);
      await requireConnectedShippingLifecycle(this.commerce,sql,current,offer,this.returning);
    });
  }
  protected async call(e:Exchange,offer:Offer,operation:ConnectedOperation,args:Record<string,unknown>,purpose:'spend'|'reconcile',
    beforeWrite?: (sql:PoolClient,current:Exchange)=>Promise<void>,beforeClaim?:()=>Promise<void>) {
    const kind=operation.startsWith('Create')?'write':'read';
    if(kind==='write' && !beforeWrite) conflict('A durable approved operation is required for this action.');
    let expectedGeneration:string|undefined,expectedInvocation:string|undefined;
    const prepare=(claim=false)=>this.commerce.repository.transaction(async sql=>{
      const current=await this.commerce.repository.get(e.id,e.sellerId,sql,true);
      const actual=current.offers.find(o=>o.version===offer.version);
      if(this.returning && (current.returnPlan?.version!==e.returnPlan?.version || digest(current.returnPlan?.quote)!==digest(e.returnPlan?.quote))) conflict('The return terms changed.');
      if(!actual || digest(actual)!==digest(offer)) conflict('The approved shipping offer changed.');
      const shipping=await this.authorize(sql,current,actual,purpose);
      const connection=(await sql.query<Connection>('select * from pilot_connections where id=$1',[shipping.connectionId])).rows[0]!;
      const descriptions=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1
        and owner_id=$2 and exchange_id=$3 and mode=$4 and generation=$5 and state='returned'
        and invocation->'tool'->>'name'='shippo_describe_tool' order by created_at desc`,
      [connection.id,e.sellerId,e.id,e.mode,connection.generation])).rows;
      const described=descriptions.find(row=>{
        try {requireShippoDescription(row,operation,kind,connectedShippingContracts[operation]);return true;} catch {return false;}
      });
      if(!described) conflict(`Describe ${operation} on the current service connection before reconciliation.`);
      const tool=connection.inspection?.tools.find(t=>t.name===`shippo_${kind}_execute_tool`);
      if(!tool) conflict('Reinspect the connected shipping service.');
      const invocation:ServiceInvocation={tool,arguments:{name:operation,arguments:args}};
      requireShippoWrapper(connection.endpoint,invocation,kind,operation);
      if(claim && (expectedGeneration!==connection.generation || expectedInvocation!==digest(invocation))) conflict('Shipping service access changed before dispatch.');
      if(claim) await beforeWrite?.(sql,current);
      return {shipping,connection,invocation};
    });
    const initial=await prepare(),connection=initial.connection;expectedGeneration=connection.generation;expectedInvocation=digest(initial.invocation);
    let tokens:OAuthTokens|undefined;
    try {
      tokens=this.secrets.open<{tokens?:OAuthTokens}>(JSON.stringify([connection.id,connection.owner_id,connection.exchange_id,connection.mode,connection.endpoint]),connection.credentials).tokens;
    } catch {conflict('Reconnect the shipping service before reconciliation.');}
    if(!tokens?.access_token) conflict('Reconnect the shipping service before reconciliation.');
    const secrets=[tokens.access_token,tokens.refresh_token].filter((v):v is string=>!!v);
    const receipt=await this.execute(connection.endpoint,initial.invocation,async()=>{
      await beforeClaim?.();
      await prepare(true);
    },publicEndpointFetch(connection.endpoint,{bearer:tokens.access_token}),
    value=>secrets.reduce((text,secret)=>text.split(secret).join('[redacted]'),value));
    if(receipt.state!=='returned') throw new ProviderFailure(true,'The connected shipping action did not return verified evidence. Reconcile its original operation before another attempt.');
    // Reject a disconnect/account change racing the network response as well.
    if(kind==='read') {
      const latest=await prepare();
      if(latest.connection.generation!==connection.generation) conflict('Shipping service access changed during reconciliation.');
    }
    // Writes may succeed during cancellation/revocation. Retain their canonical
    // identity for recovery instead of discarding the result and losing it.
    return {receipt,shipping:initial.shipping};
  }
  async preflight(e:Exchange,offer:Offer) {
    const quote=this.quote(e,offer);
    const {receipt,shipping}=await this.call(e,offer,'GetRate',{RateId:quote.rateId},'spend');
    const rate=shippoRate(shippoPayload(receipt),{shipmentId:quote.shipmentId,accountOwner:shipping.accountOwner,mode:'live'},new Date());
    if(rate.rateId!==quote.rateId || rate.carrierAccountId!==quote.carrierAccountId
      || rate.carrierName!==quote.carrier || rate.serviceToken!==quote.service
      || rate.amount!==quote.shippingAmount || rate.currency!==quote.currency
      || !rate.purchaseBefore || Date.parse(rate.purchaseBefore)<Date.parse(quote.expiresAt)
      || (!this.returning && e.resolution?.remedy==='renew_postage' && Date.parse(rate.purchaseBefore)<Date.parse(e.resolution.expiresAt))) {
      conflict('The connected shipping rate changed. Prepare and approve a new offer.');
    }
    const carrier=await this.call(e,offer,'GetCarrierAccount',{CarrierAccountId:rate.carrierAccountId},'spend');
    const checked=shippoCarrier(carrier.receipt,{accountOwner:shipping.accountOwner,carrierAccountId:rate.carrierAccountId,mode:'live'});
    if(checked.carrierToken!==shipping.carrierToken) conflict('The selected carrier changed. Prepare a new offer.');
    return rate;
  }
  async transaction(e:Exchange,offer:Offer,operationId:string,transactionId:string) {
    const quote=this.quote(e,offer),kind=this.returning?'return_label':'label';
    // IDs must come from this offer's persisted label operation, never a client.
    const saved=(await this.commerce.repository.pool.query(`select id from pilot_operations where id=$1 and exchange_id=$2
      and mode=$3 and kind=$6 and version=$4 and provider_id=$5`,[operationId,e.id,e.mode,this.version(e,offer),transactionId,kind])).rows[0];
    if(!saved) conflict('The purchased shipping transaction has not been recorded.');
    const {receipt,shipping}=await this.call(e,offer,'GetTransaction',{TransactionId:transactionId},'reconcile');
    const fact=shippoTransaction(receipt,{operationId,accountOwner:shipping.accountOwner,mode:'live',rateId:quote.rateId,
      parcelId:shipping.parcelId,artifact:quote.artifact,qrRequested:shipping.qrRequested,carrierToken:shipping.carrierToken},transactionId);
    await this.commerce.repository.pool.query(`update pilot_operations set result=coalesce(result,'{}'::jsonb)||'{"referenceUnverified":false}'::jsonb
      where id=$1 and provider_id=$2 and result->>'referenceUnverified'='true'`,[operationId,transactionId]);
    return fact;
  }
  async tracking(e:Exchange,offer:Offer,operationId:string,transactionId:string) {
    const transaction=await this.transaction(e,offer,operationId,transactionId);
    if(transaction.state!=='purchased') conflict('Tracking requires a verified purchased transaction.');
    const bound=this.returning?(await this.commerce.repository.privateInput(e,e.buyerId)).connectedReturn?.shipping
      :(await this.commerce.repository.privateInput(e,e.sellerId)).connectedShipping?.[String(offer.version)];
    if(!bound) conflict('The shipping authorization is missing.');
    const {receipt,shipping}=await this.call(e,offer,'GetTrack',{Carrier:bound.carrierToken,
      TrackingNumber:transaction.trackingNumber},'reconcile');
    return shippoTracking(receipt,{transactionId,trackingNumber:transaction.trackingNumber,carrierToken:shipping.carrierToken});
  }
  async refund(e:Exchange,offer:Offer,transactionId:string,refundId:string) {
    const saved=(await this.commerce.repository.pool.query(`select id from pilot_operations where exchange_id=$1 and mode=$2
      and kind=$6 and version=$3 and provider_id=$4 and result->>'transactionId'=$5`,
    [e.id,e.mode,this.version(e,offer),refundId,transactionId,this.returning?'return_label_refund':'label_refund'])).rows[0];
    if(!saved) conflict('The postage refund has not been recorded.');
    const {receipt,shipping}=await this.call(e,offer,'GetRefund',{RefundId:refundId},'reconcile');
    const fact=shippoRefund(receipt,{transactionId,accountOwner:shipping.accountOwner,mode:'live'},refundId);
    await this.commerce.repository.pool.query(`update pilot_operations set result=coalesce(result,'{}'::jsonb)||'{"referenceUnverified":false}'::jsonb
      where id=$1 and provider_id=$2 and result->>'referenceUnverified'='true'`,[saved.id,refundId]);
    return fact;
  }
}
