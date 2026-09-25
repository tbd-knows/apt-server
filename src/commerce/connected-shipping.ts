import type { PoolClient } from 'pg';
import type { Exchange, Offer, Operation } from './domain.js';
import { approvalFor, conflict, digest } from './domain.js';
import { ConnectedShippingRead } from './connected-shipping-read.js';
import { shippoOperationMetadata, shippoRefund, shippoTransaction, shippoTransactionIdentity, type ShippoTransactionBinding } from './shippo-evidence.js';
import { ProviderFailure } from './providers.js';

/** Only the durable worker can call these writes. The model surface remains
 * preparation-only. A transport failure never authorizes a second purchase. */
export class ConnectedShipping extends ConnectedShippingRead {
  private async claim(sql:PoolClient,e:Exchange,offer:Offer,op:Operation,kind:'label'|'label_refund',extra:Record<string,unknown>={}) {
    if(e.mode!=='live' || op.mode!==e.mode || op.exchangeId!==e.id || op.version!==offer.version || op.kind!==kind) {
      conflict('Connected postage requires matching live payment and shipping operations.');
    }
    const saved=(await sql.query(`select * from pilot_operations where id=$1 and exchange_id=$2 and mode=$3
      and kind=$4 and version=$5 for update`,[op.id,e.id,e.mode,kind,offer.version])).rows[0];
    if(!saved || saved.state!=='running' || saved.provider_id || saved.result?.effectStarted) {
      throw new ProviderFailure(true,'The original shipping action must be reconciled; another dispatch is not authorized.');
    }
    await sql.query(`update pilot_operations set result=coalesce(result,'{}'::jsonb)||$2::jsonb,updated_at=now() where id=$1`,
      [op.id,{...extra,effectStarted:true,offerDigest:digest(offer)}]);
  }
  async purchase(e:Exchange,offer:Offer,op:Operation,verifyPayment:()=>Promise<void>) {
    if(op.providerId) return this.transaction(e,offer,op.id,op.providerId);
    if(op.result?.effectStarted) throw new ProviderFailure(true,'Postage purchase outcome is unknown. Reconcile the original transaction; never buy again.');
    await this.preflight(e,offer);
    const {receipt,shipping}=await this.call(e,offer,'CreateTransaction',{
      rate:offer.quote.rateId,label_file_type:'PDF',metadata:shippoOperationMetadata(op.id),async:false,
    },'spend',async(sql,current)=>{
      if(current.cancellationRequested || current.payment!=='paid' || current.problem
        || Object.keys(current.operationIssues ?? {}).some(id=>id!==op.id)) conflict('Postage requires confirmed payment and a resolved, uncancelled order.');
      if(current.offers.at(-1)?.version!==offer.version || current.approvals.length!==2
        || ![current.buyerId,current.sellerId].every(actor=>current.approvals.some(a=>digest(a)===digest(approvalFor(current,actor))))) {
        conflict('Both current sale approvals are required for postage.');
      }
      await this.claim(sql,current,offer,op,'label');
    },verifyPayment);
    const binding:ShippoTransactionBinding={operationId:op.id,accountOwner:shipping.accountOwner,mode:'live',rateId:offer.quote.rateId,
      parcelId:shipping.parcelId,artifact:offer.quote.artifact,qrRequested:shipping.qrRequested,carrierToken:shipping.carrierToken};
    const id=shippoTransactionIdentity(receipt,binding);
    // Persist BEFORE interpreting SUCCESS, QR/PDF or tracking details. An error
    // after a purchase must retain a reference usable for later recovery.
    await this.commerce.repository.pool.query(`update pilot_operations set provider_id=$2,updated_at=now()
      where id=$1 and (provider_id is null or provider_id=$2)`,[op.id,id]);
    return shippoTransaction(receipt,binding,id);
  }
  async requestRefund(e:Exchange,offer:Offer,op:Operation,label:Operation) {
    if(!label.providerId || label.kind!=='label' || label.exchangeId!==e.id || label.version!==offer.version) conflict('A recorded postage purchase is required.');
    if(op.providerId) return this.refund(e,offer,label.providerId,op.providerId);
    const transaction=await this.transaction(e,offer,label.id,label.providerId);
    if(transaction.state==='refunded') return {refundId:null,state:'refunded' as const};
    if(transaction.state==='refund_pending') return {refundId:null,state:'pending' as const};
    if(transaction.state==='refund_rejected') return {refundId:null,state:'rejected' as const};
    if(transaction.state!=='purchased') conflict('The postage purchase must reconcile before requesting a refund.');
    if(op.result?.effectStarted) throw new ProviderFailure(true,'Postage refund submission is uncertain. Reconcile the original refund; never submit another.');
    const tracking=await this.tracking(e,offer,label.id,label.providerId);
    if(tracking.state!=='label_ready') conflict('Confirm unused postage with the carrier before requesting a refund.');
    const transactionId=label.providerId;
    const {receipt,shipping}=await this.call(e,offer,'CreateRefund',{transaction:transactionId,async:false},'reconcile',async(sql,current)=>{
      if(current.payment!=='refunded' || current.sellerDroppedAt || current.carrierAcceptedAt
        || ['in_transit','delivered','exception'].includes(current.shipping)) conflict('Only unused postage after a confirmed buyer refund can be refunded automatically.');
      const currentLabel=(await sql.query('select provider_id from pilot_operations where id=$1 and exchange_id=$2 and kind=\'label\' and version=$3',
        [label.id,e.id,offer.version])).rows[0];
      if(currentLabel?.provider_id!==transactionId) conflict('The postage transaction changed.');
      await this.claim(sql,current,offer,op,'label_refund',{transactionId});
    });
    const refund=shippoRefund(receipt,{transactionId,accountOwner:shipping.accountOwner,mode:'live'});
    await this.commerce.repository.pool.query(`update pilot_operations set provider_id=$2,updated_at=now()
      where id=$1 and (provider_id is null or provider_id=$2)`,[op.id,refund.refundId]);
    return refund;
  }
}
