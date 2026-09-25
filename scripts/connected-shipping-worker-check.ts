import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { approvalFor, type Exchange, type Operation } from '../src/commerce/domain.js';
import { ConnectedShipping } from '../src/commerce/connected-shipping.js';
import { connectedShippingContracts } from '../src/commerce/connected-shipping-read.js';
import { CommerceWorker } from '../src/commerce/worker.js';
import { CommerceService } from '../src/commerce/service.js';
import { type CommerceRepository } from '../src/commerce/repository.js';
import { EasyPostProvider, StripeProvider, providerConfig, type PaymentFact } from '../src/commerce/providers.js';
import { FedExLocations } from '../src/commerce/locations.js';
import { executeMcp } from '../src/commerce/mcp-execution.js';
import { shippoOperationMetadata } from '../src/commerce/shippo-evidence.js';
import type { ServiceInvocation } from '../src/commerce/mcp-execution.js';

/** Called by shipping-rates-db-check after actual SDK preparation/approval.
 * Postgres and the MCP SDK are real; all provider responses are fixtures. The
 * disposable exchange's live tag tests mode binding, never real spending. */
export async function checkConnectedWorker(repository:CommerceRepository,original:Exchange,connection:string,root:string,
  tools:ServiceInvocation['tool'][],describe:(name:string,kind:string,fields:Record<string,string>)=>Promise<string>) {
  const pool=repository.pool,e=structuredClone(original),offer=e.offers.at(-1)!;
  const service=new CommerceService(repository,[e.buyerId,e.sellerId],'live',undefined,null,true);
  const config=providerConfig({},'live');
  let labelId=randomUUID(),checkoutId=randomUUID(),refundId=randomUUID();
  let purchases=0,refunds=0,reads=0,paidChecks=0,checkouts=0;
  let transactionStatus='SUCCESS',trackingStatus='PRE_TRANSIT',refundStatus='PENDING';
  let malformedLabel=false,losePurchase=false,loseRefund=false,trackingFails=false;
  let eventTime=new Date().toISOString();
  let beforeDispatch:((name:string)=>Promise<void>)|undefined,afterDispatch:((name:string)=>Promise<void>)|undefined;
  const fact:PaymentFact={sessionId:'cs_connected_fixture',status:'paid',amount:offer.buyerTotal,currency:'usd',
    paymentIntentId:'pi_fixture',chargeId:'ch_fixture',transferId:'tr_fixture',transferred:true,transferReversed:false,
    transferReversedAmount:0,refunded:false,refundedAmount:0,destinationPaymentId:'py_fixture',checkoutUrl:null};
  class StripeFixture extends StripeProvider {
    override async retrieve() {paidChecks++;return {...fact};}
    override async checkout() {checkouts++;return {...fact,status:'open' as const};}
  }
  const fixtureFetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));
    if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'connected-worker-fixture',version:'1'}};
    else if(message.method==='tools/list') result={tools};
    else {
      const {name,arguments:args}=message.params.arguments;
      assert(!JSON.stringify(args).includes('CANARY'));
      const isWrite=name.startsWith('Create');
      assert.equal(message.params.name,`shippo_${isWrite?'write':'read'}_execute_tool`);
      let payload:unknown;
      const transaction={object_id:'transaction_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,
        metadata:shippoOperationMetadata(labelId),rate:offer.quote.rateId,parcel:'parcel_fixture',status:transactionStatus,
        tracking_number:'TRACKING_FIXTURE',label_file_type:'PDF',label_url:malformedLabel?'http://unsafe.invalid/':
          'https://deliver.goshippo.com/label.pdf?signature=PRIVATE_ARTIFACT_CANARY'};
      if(name==='CreateTransaction') {
        purchases++;
        assert.deepEqual(args,{rate:offer.quote.rateId,label_file_type:'PDF',metadata:shippoOperationMetadata(labelId),async:false});
        const saved=(await pool.query('select state,result from pilot_operations where id=$1',[labelId])).rows[0];
        assert.equal(saved.state,'running');assert.equal(saved.result.effectStarted,true);assert(paidChecks>0);
        if(losePurchase) throw new Error('synthetic disconnect after purchase');
        payload=transaction;
      } else if(name==='GetTransaction') {reads++;assert.deepEqual(args,{TransactionId:'transaction_fixture'});payload=transaction;}
      else if(name==='GetRate') payload={object_id:offer.quote.rateId,object_owner:'PRIVATE_ACCOUNT_CANARY',object_created:new Date().toISOString(),
        test:false,shipment:offer.quote.shipmentId,carrier_account:offer.quote.carrierAccountId,provider:offer.quote.carrier,
        servicelevel:{token:offer.quote.service,name:'Ground'},amount:'8.05',currency:'USD'};
      else if(name==='GetCarrierAccount') payload={object_id:offer.quote.carrierAccountId,object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,active:true,carrier:'fedex'};
      else if(name==='GetTrack') {
        if(trackingFails) throw new Error('synthetic tracking outage');
        assert.deepEqual(args,{Carrier:'fedex',TrackingNumber:'TRACKING_FIXTURE'});
        payload={carrier:'fedex',tracking_number:'TRACKING_FIXTURE',transaction:'transaction_fixture',
          tracking_status:{object_id:`event_${trackingStatus}`,object_updated:eventTime,status_date:eventTime,status:trackingStatus}};
      } else if(name==='CreateRefund') {
        refunds++;assert.deepEqual(args,{transaction:'transaction_fixture',async:false});
        const saved=(await pool.query('select state,result from pilot_operations where id=$1',[refundId])).rows[0];
        assert.equal(saved.state,'running');assert.equal(saved.result.effectStarted,true);assert.equal(saved.result.transactionId,'transaction_fixture');
        if(loseRefund) throw new Error('synthetic disconnect after refund');
        payload={object_id:'refund_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,transaction:'transaction_fixture',status:refundStatus};
      } else {
        assert.equal(name,'GetRefund');assert.deepEqual(args,{RefundId:'refund_fixture'});
        payload={object_id:'refund_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,transaction:'transaction_fixture',status:refundStatus};
      }
      await afterDispatch?.(name);
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const driver=()=>new ConnectedShipping(service,root,(url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,async()=>{
    await beforeDispatch?.(String(invocation.arguments.name));await before();
  },fixtureFetch,redact));
  const worker=()=>new CommerceWorker(repository,service,{stripe:new StripeFixture(config),connectedShipping:driver(),
    shipping:new EasyPostProvider(config,async()=>{assert.fail('Connected order reached platform shipping');}),locations:new FedExLocations(config)});
  const save=async(value:Exchange)=>pool.query('update pilot_exchanges set data=$2 where id=$1',[e.id,value]);
  const current=()=>repository.get(e.id,e.buyerId);
  const op=async(id:string):Promise<Operation>=>{
    const row=(await pool.query('select * from pilot_operations where id=$1',[id])).rows[0];
    return {id:row.id,exchangeId:row.exchange_id,mode:row.mode,kind:row.kind,version:row.version,state:row.state,
      providerId:row.provider_id,result:row.result,attempts:row.attempts,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
  };
  const run=async(id=labelId)=>worker().process(await op(id));
  const attach=async(actor:string,id:string,providerId:string)=>{
    const view=await service.get(actor,e.id);
    return service.command(actor,e.id,randomUUID(),view.revision,{type:'attach_provider_reference',operationId:id,providerId,reason:'Recover the original provider operation.'});
  };
  const insert=async(id:string,kind:string,providerId:string|null=null)=>pool.query(`insert into pilot_operations(id,exchange_id,mode,kind,version,state,provider_id)
    values($1,$2,'live',$3,$4,'pending',$5)`,[id,e.id,kind,offer.version,providerId]);
  const reset=async()=>{
    await pool.query('delete from pilot_operations where exchange_id=$1',[e.id]);
    const clean=structuredClone(e);clean.approvals=[approvalFor(clean,e.buyerId),approvalFor(clean,e.sellerId)];
    clean.payment='paid';clean.shipping='label_pending';clean.stage='fulfilling';clean.cancellationRequested=false;
    clean.problem=null;clean.operationIssues={};await save(clean);
    labelId=randomUUID();checkoutId=randomUUID();refundId=randomUUID();purchases=0;refunds=0;paidChecks=0;checkouts=0;
    transactionStatus='SUCCESS';trackingStatus='PRE_TRANSIT';refundStatus='PENDING';eventTime=new Date().toISOString();
    malformedLabel=false;losePurchase=false;loseRefund=false;trackingFails=false;beforeDispatch=undefined;afterDispatch=undefined;
    fact.status='paid';fact.transferred=true;fact.refunded=false;fact.refundedAmount=0;fact.transferReversed=false;fact.transferReversedAmount=0;
    await insert(checkoutId,'checkout','cs_connected_fixture');await insert(labelId,'label');
  };
  const originalOperations=(await pool.query('select * from pilot_operations where exchange_id=$1',[e.id])).rows;
  const originalItem=(await pool.query('select * from pilot_items where id=$1',[offer.item.itemId])).rows[0];
  try {
    await pool.query("update pilot_items set mode='live' where id=$1",[offer.item.itemId]);
    await assert.rejects(driver().requireLifecycle(e,offer),/Describe CreateTransaction/);
    const unavailable=await service.get(e.buyerId,e.id);assert.equal(unavailable.execution.connectedShippingReady,false);
    await assert.rejects(service.command(e.buyerId,e.id,randomUUID(),unavailable.revision,{type:'checkout'}),/Describe CreateTransaction/);
    assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='checkout'",[e.id])).rows[0].n,0);
    for(const [name,fields] of Object.entries(connectedShippingContracts)) await describe(name,name.startsWith('Create')?'write':'read',fields);
    await pool.query("update pilot_service_actions set mode='live' where connection_id=$1",[connection]);
    await driver().requireLifecycle(e,offer);
    // Human checkout admission, then connected preflight; no platform keys.
    await reset();await pool.query('delete from pilot_operations where exchange_id=$1',[e.id]);
    const ready=await current();ready.stage='offered';ready.payment='unpaid';ready.shipping='none';await save(ready);
    const readyView=await service.get(e.buyerId,e.id);assert.equal(readyView.execution.connectedShippingReady,true);
    await service.command(e.buyerId,e.id,randomUUID(),readyView.revision,{type:'checkout'});
    checkoutId=(await pool.query("select id from pilot_operations where exchange_id=$1 and kind='checkout'",[e.id])).rows[0].id;
    await run(checkoutId);assert.equal(checkouts,1);assert.equal((await op(checkoutId)).providerId,'cs_connected_fixture');
    await run(checkoutId);
    labelId=(await pool.query("select id from pilot_operations where exchange_id=$1 and kind='label'",[e.id])).rows[0].id;
    await run();assert.equal(purchases,1);assert.equal((await current()).shipping,'label_ready');
    // Two concurrent workers + process restart still purchase exactly once.
    await reset();await Promise.all([run(),run()]);await run();
    assert.equal(purchases,1);assert.equal(paidChecks,1);assert.equal((await current()).shipping,'label_ready');
    assert.equal((await op(labelId)).result?.effectStarted,true);
    trackingStatus='TRANSIT';await run();assert.equal((await current()).shipping,'in_transit');
    trackingStatus='PRE_TRANSIT';eventTime=new Date(Date.now()-60_000).toISOString();await run();assert.equal((await current()).shipping,'in_transit');
    trackingStatus='DELIVERED';eventTime=new Date().toISOString();await run();assert.equal((await current()).shipping,'delivered');
    trackingStatus='TRANSIT';await run();assert.equal((await current()).shipping,'delivered');
    const delivered=await service.get(e.buyerId,e.id);
    await service.command(e.buyerId,e.id,randomUUID(),delivered.revision,{type:'received'});assert.equal((await current()).stage,'completed');
    assert.equal(purchases,1);
    // Canonical Stripe state is checked after MCP catalogue discovery, before
    // dispatch. A locally paid order is insufficient.
    for(const mutation of ['unpaid','untransferred','partial','reversed','cancel','approval','revoked','schema'] as const) {
      await reset();
      beforeDispatch=async name=>{if(name!=='CreateTransaction') return;
        if(mutation==='unpaid') fact.status='unpaid';
        if(mutation==='untransferred') fact.transferred=false;
        if(mutation==='partial') fact.refundedAmount=1;
        if(mutation==='reversed') fact.transferReversedAmount=1;
        if(mutation==='cancel' || mutation==='approval') {const changed=await current();if(mutation==='cancel') changed.cancellationRequested=true;else changed.approvals=[];await save(changed);}
        if(mutation==='revoked') await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);
        if(mutation==='schema') await pool.query("update pilot_connections set inspection=jsonb_set(inspection,'{tools}',$2) where id=$1",
          [connection,JSON.stringify(tools.map(tool=>({...tool,description:'Changed after SDK discovery'})))]);
      };
      await run();assert.equal(purchases,0,mutation);assert.equal((await op(labelId)).result?.effectStarted,undefined,mutation);
      await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);
      await pool.query("update pilot_connections set inspection=jsonb_set(inspection,'{tools}',$2) where id=$1",[connection,JSON.stringify(tools)]);
    }
    // A malformed artifact retains the transaction for a later canonical read.
    await reset();malformedLabel=true;await run();assert.equal(purchases,1);assert.equal((await op(labelId)).providerId,'transaction_fixture');
    malformedLabel=false;await pool.query("update pilot_operations set state='uncertain' where id=$1",[labelId]);await run();
    assert.equal(purchases,1);assert.equal((await current()).shipping,'label_ready');
    // Unknown result never repeats CreateTransaction, including a fresh worker.
    await reset();losePurchase=true;await run();await run();assert.equal(purchases,1);assert.equal((await op(labelId)).providerId,null);
    losePurchase=false;
    await assert.rejects(attach(e.buyerId,labelId,'transaction_fixture'),/other participant/);
    assert.equal((await service.get(e.buyerId,e.id)).operations.find(o=>o.id===labelId)?.providerReferenceEditable,false);
    assert.equal((await service.get(e.sellerId,e.id)).operations.find(o=>o.id===labelId)?.providerReferenceEditable,true);
    await attach(e.sellerId,labelId,'wrong_transaction');await run();
    assert.equal((await op(labelId)).result?.referenceUnverified,true);assert.equal((await current()).shipping,'label_pending');
    await attach(e.sellerId,labelId,'transaction_fixture');
    await run();assert.equal(purchases,1);assert.equal((await current()).shipping,'label_ready');
    assert.equal((await op(labelId)).result?.referenceUnverified,false);
    // Cancellation after dispatch must not discard the successful purchase.
    await reset();afterDispatch=async name=>{if(name!=='CreateTransaction') return;const changed=await current();changed.cancellationRequested=true;changed.payment='refunded';await save(changed);};
    await run();assert.equal((await op(labelId)).providerId,'transaction_fixture');
    assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='label_refund'",[e.id])).rows[0].n,1);
    await reset();afterDispatch=async name=>{if(name==='CreateTransaction') await pool.query("update pilot_connections set state='revoked' where id=$1",[connection]);};
    await run();assert.equal(purchases,1);assert.equal((await op(labelId)).providerId,'transaction_fixture');
    assert.equal((await op(labelId)).state,'succeeded');
    await pool.query("update pilot_connections set state='connected' where id=$1",[connection]);afterDispatch=undefined;
    await run();assert.equal(purchases,1);
    // Tracking failure cannot erase purchased postage or trigger another buy.
    await reset();trackingFails=true;await run();assert.equal((await op(labelId)).state,'succeeded');assert.equal((await current()).shipping,'label_ready');
    trackingFails=false;await run();assert.equal(purchases,1);assert.equal((await current()).stage,'fulfilling');
    // A label pending at the provider is polled by ID until ready.
    await reset();transactionStatus='WAITING';await run();assert.equal((await op(labelId)).providerId,'transaction_fixture');
    transactionStatus='SUCCESS';await run();assert.equal(purchases,1);assert.equal((await current()).shipping,'label_ready');
    // Refund submission is once-only and distinct from the confirmed Stripe
    // refund. Its original transaction binding survives done()/restart.
    await reset();await run();const cancelled=await current();cancelled.payment='refunded';cancelled.cancellationRequested=true;await save(cancelled);
    await insert(refundId,'label_refund');await run(refundId);await run(refundId);
    assert.equal(refunds,1);assert.equal((await op(refundId)).result?.transactionId,'transaction_fixture');
    assert.equal((await op(refundId)).result?.refundStatus,'submitted');refundStatus='SUCCESS';await run(refundId);
    assert.equal((await op(refundId)).result?.refundStatus,'refunded');assert.equal((await current()).payment,'refunded');
    // An interrupted refund can settle from the original transaction status.
    await reset();await run();const refunded=await current();refunded.payment='refunded';refunded.cancellationRequested=true;await save(refunded);
    await insert(refundId,'label_refund');loseRefund=true;await run(refundId);await run(refundId);assert.equal(refunds,1);
    transactionStatus='REFUNDED';await run(refundId);assert.equal(refunds,1);assert.equal((await op(refundId)).result?.refundStatus,'refunded');
    await reset();await run();const refundCandidate=await current();refundCandidate.payment='refunded';await save(refundCandidate);
    await insert(refundId,'label_refund');loseRefund=true;await run(refundId);
    await assert.rejects(attach(e.buyerId,refundId,'refund_fixture'),/other participant/);
    await attach(e.sellerId,refundId,'refund_fixture');refundStatus='SUCCESS';await run(refundId);
    assert.equal(refunds,1);assert.equal((await op(refundId)).result?.referenceUnverified,false);
    assert.equal((await op(refundId)).result?.refundStatus,'refunded');
    // A carrier handoff blocks the unused-postage refund even if the local
    // exchange had not yet seen that tracking event.
    await reset();await run();const inTransit=await current();inTransit.payment='refunded';await save(inTransit);trackingStatus='TRANSIT';
    await insert(refundId,'label_refund');await run(refundId);assert.equal(refunds,0);
    for(const actor of [e.buyerId,e.sellerId]) {
      const projection=JSON.stringify(await service.get(actor,e.id));
      for(const secret of ['PRIVATE_ACCOUNT_CANARY','PRIVATE_ARTIFACT_CANARY','TOKEN_CANARY']) assert(!projection.includes(secret));
    }
    assert(reads>0);
    process.stdout.write('PASS: connected worker exact once-only purchase, canonical payment/approval/revocation fences, persisted transaction identity, concurrency/restart, pending/malformed/unknown recovery, cancellation races, monotonic tracking/delivery/receipt, separate once-only postage refund, unknown refund recovery, handoff denial and private evidence. Provider responses are fixtures.\n');
  } finally {
    await pool.query('delete from pilot_operations where exchange_id=$1',[e.id]);
    await pool.query('insert into pilot_operations select * from jsonb_populate_recordset(null::pilot_operations,$1::jsonb)',[JSON.stringify(originalOperations)]);
    await pool.query('update pilot_items set mode=$2,sold=$3,reserved_by=$4,reserved_until=$5 where id=$1',
      [originalItem.id,originalItem.mode,originalItem.sold,originalItem.reserved_by,originalItem.reserved_until]);
    await save(original);
  }
}
