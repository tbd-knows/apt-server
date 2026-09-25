import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { CommerceService } from './service.js';
import { requireConnectedOffer } from './connected-offer.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { conflict, digest, type Exchange, type Offer } from './domain.js';
import { executeMcp, type ServiceInvocation } from './mcp-execution.js';
import { publicEndpointFetch } from './public-http.js';
import { requireShippoDescription, requireShippoWrapper } from './shipping-validation.js';
import type { ServiceActionRow } from './service-actions.js';
import { shippoCarrier, shippoPayload, shippoRate, shippoRefund, shippoTracking, shippoTransaction } from './shippo-evidence.js';
import { ProviderFailure } from './providers.js';

const contracts = {
  GetRate: { RateId: 'string' }, GetCarrierAccount: { CarrierAccountId: 'string' },
  GetTransaction: { TransactionId: 'string' }, GetTrack: { Carrier: 'string', TrackingNumber: 'string' },
  GetRefund: { RefundId: 'string' },
} as const;
type Read = keyof typeof contracts;
interface Connection {
  id:string; owner_id:string; exchange_id:string; mode:string; endpoint:string; generation:string;
  credentials:string; inspection:{tools:ServiceInvocation['tool'][]};
}

/** Read-only execution of an approved offer's known provider objects. No
 * arbitrary model arguments, new shipment creation, postage purchase or refund
 * submission is exposed here. Reauthorization permits canonical reads while
 * the original generation and expiry still fence any future spending. */
export class ConnectedShippingRead {
  private readonly secrets:ConnectionSecrets;
  constructor(private readonly commerce:CommerceService,rootSecret:string,private readonly execute=executeMcp) {
    this.secrets=new ConnectionSecrets(rootSecret);
  }
  private async read(e:Exchange,offer:Offer,operation:Read,args:Record<string,string>,purpose:'spend'|'reconcile') {
    const prepare=()=>this.commerce.repository.transaction(async sql=>{
      const current=await this.commerce.repository.get(e.id,e.sellerId,sql,true);
      const actual=current.offers.find(o=>o.version===offer.version);
      if(!actual || digest(actual)!==digest(offer)) conflict('The approved shipping offer changed.');
      const shipping=await requireConnectedOffer(this.commerce,sql,current,actual,purpose);
      const connection=(await sql.query<Connection>('select * from pilot_connections where id=$1',[shipping.connectionId])).rows[0]!;
      const descriptions=(await sql.query<ServiceActionRow>(`select * from pilot_service_actions where connection_id=$1
        and owner_id=$2 and exchange_id=$3 and mode=$4 and generation=$5 and state='returned'
        and invocation->'tool'->>'name'='shippo_describe_tool' order by created_at desc`,
      [connection.id,e.sellerId,e.id,e.mode,connection.generation])).rows;
      const described=descriptions.find(row=>{
        try {requireShippoDescription(row,operation,'read',contracts[operation]);return true;} catch {return false;}
      });
      if(!described) conflict(`Describe ${operation} on the current service connection before reconciliation.`);
      const tool=connection.inspection?.tools.find(t=>t.name==='shippo_read_execute_tool');
      if(!tool) conflict('Reinspect the connected shipping service.');
      const invocation:ServiceInvocation={tool,arguments:{name:operation,arguments:args}};
      requireShippoWrapper(connection.endpoint,invocation,'read',operation);
      return {shipping,connection,invocation};
    });
    const initial=await prepare(),connection=initial.connection;
    let tokens:OAuthTokens|undefined;
    try {
      tokens=this.secrets.open<{tokens?:OAuthTokens}>(JSON.stringify([connection.id,connection.owner_id,connection.exchange_id,connection.mode,connection.endpoint]),connection.credentials).tokens;
    } catch {conflict('Reconnect the shipping service before reconciliation.');}
    if(!tokens?.access_token) conflict('Reconnect the shipping service before reconciliation.');
    const secrets=[tokens.access_token,tokens.refresh_token].filter((v):v is string=>!!v);
    const receipt=await this.execute(connection.endpoint,initial.invocation,async()=>{
      const current=await prepare();
      if(current.connection.generation!==connection.generation || digest(current.invocation)!==digest(initial.invocation)) {
        conflict('Shipping service access changed before the read.');
      }
    },publicEndpointFetch(connection.endpoint,{bearer:tokens.access_token}),
    value=>secrets.reduce((text,secret)=>text.split(secret).join('[redacted]'),value));
    if(receipt.state!=='returned') throw new ProviderFailure(true,'The connected shipping read did not return verified evidence. Retry the read; do not create another purchase.');
    // Reject a disconnect/account change racing the network response as well.
    const latest=await prepare();
    if(latest.connection.generation!==connection.generation) conflict('Shipping service access changed during reconciliation.');
    return {receipt,shipping:initial.shipping};
  }
  async preflight(e:Exchange,offer:Offer) {
    const {receipt,shipping}=await this.read(e,offer,'GetRate',{RateId:offer.quote.rateId},'spend');
    const rate=shippoRate(shippoPayload(receipt),{shipmentId:offer.quote.shipmentId,accountOwner:shipping.accountOwner,mode:'live'},new Date());
    if(rate.rateId!==offer.quote.rateId || rate.carrierAccountId!==offer.quote.carrierAccountId
      || rate.carrierName!==offer.quote.carrier || rate.serviceToken!==offer.quote.service
      || rate.amount!==offer.quote.shippingAmount || rate.currency!==offer.quote.currency
      || !rate.purchaseBefore || Date.parse(rate.purchaseBefore)<Date.parse(offer.expiresAt)) {
      conflict('The connected shipping rate changed. Prepare and approve a new offer.');
    }
    const carrier=await this.read(e,offer,'GetCarrierAccount',{CarrierAccountId:rate.carrierAccountId},'spend');
    const checked=shippoCarrier(carrier.receipt,{accountOwner:shipping.accountOwner,carrierAccountId:rate.carrierAccountId,mode:'live'});
    if(checked.carrierToken!==shipping.carrierToken) conflict('The selected carrier changed. Prepare a new offer.');
    return rate;
  }
  async transaction(e:Exchange,offer:Offer,operationId:string,transactionId:string) {
    // IDs must come from this offer's persisted label operation, never a client.
    const saved=(await this.commerce.repository.pool.query(`select id from pilot_operations where id=$1 and exchange_id=$2
      and mode=$3 and kind='label' and version=$4 and provider_id=$5`,[operationId,e.id,e.mode,offer.version,transactionId])).rows[0];
    if(!saved) conflict('The purchased shipping transaction has not been recorded.');
    const {receipt,shipping}=await this.read(e,offer,'GetTransaction',{TransactionId:transactionId},'reconcile');
    return shippoTransaction(receipt,{operationId,accountOwner:shipping.accountOwner,mode:'live',rateId:offer.quote.rateId,
      parcelId:shipping.parcelId,artifact:offer.quote.artifact,qrRequested:shipping.qrRequested,carrierToken:shipping.carrierToken},transactionId);
  }
  async tracking(e:Exchange,offer:Offer,operationId:string,transactionId:string) {
    const transaction=await this.transaction(e,offer,operationId,transactionId);
    if(transaction.state!=='purchased') conflict('Tracking requires a verified purchased transaction.');
    const bound=(await this.commerce.repository.privateInput(e,e.sellerId)).connectedShipping?.[String(offer.version)];
    if(!bound) conflict('The shipping authorization is missing.');
    const {receipt,shipping}=await this.read(e,offer,'GetTrack',{Carrier:bound.carrierToken,
      TrackingNumber:transaction.trackingNumber},'reconcile');
    return shippoTracking(receipt,{transactionId,trackingNumber:transaction.trackingNumber,carrierToken:shipping.carrierToken});
  }
  async refund(e:Exchange,offer:Offer,transactionId:string,refundId:string) {
    const saved=(await this.commerce.repository.pool.query(`select id from pilot_operations where exchange_id=$1 and mode=$2
      and kind='label_refund' and version=$3 and provider_id=$4 and result->>'transactionId'=$5`,
    [e.id,e.mode,offer.version,refundId,transactionId])).rows[0];
    if(!saved) conflict('The postage refund has not been recorded.');
    const {receipt,shipping}=await this.read(e,offer,'GetRefund',{RefundId:refundId},'reconcile');
    return shippoRefund(receipt,{transactionId,accountOwner:shipping.accountOwner,mode:'live'},refundId);
  }
}
