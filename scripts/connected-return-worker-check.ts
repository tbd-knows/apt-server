/** Real Postgres/MCP SDK/worker, synthetic provider transport; no real purchase. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import {type Exchange,type Operation,returnBinding,returnCancellationBinding} from '../src/commerce/domain.js';
import {CommerceService} from '../src/commerce/service.js';
import {CommerceWorker} from '../src/commerce/worker.js';
import {CommerceAssets} from '../src/commerce/assets.js';
import {ConnectedShipping} from '../src/commerce/connected-shipping.js';
import {connectedShippingContracts} from '../src/commerce/connected-shipping-read.js';
import {executeMcp,type ServiceInvocation} from '../src/commerce/mcp-execution.js';
import {shippoOperationMetadata} from '../src/commerce/shippo-evidence.js';
import {EasyPostProvider,StripeProvider,providerConfig,type PaymentFact} from '../src/commerce/providers.js';
import {FedExLocations} from '../src/commerce/locations.js';

export async function checkConnectedReturnWorker(service:CommerceService,initial:Exchange,root:string,tools:ServiceInvocation['tool'][],
  describe:(name:string,kind:string,fields:Record<string,string>)=>Promise<string>,human?:(actor:string,input:unknown)=>Promise<unknown>) {
  const repository=service.repository,pool=repository.pool,A=initial.buyerId,B=initial.sellerId,offer=initial.offers.at(-1)!,quote=initial.returnPlan!.quote!;
  const originalRows=(await pool.query('select * from pilot_operations where exchange_id=$1',[initial.id])).rows;
  const originalPrivate=await repository.privateInput(initial,A);
  const current=()=>repository.get(initial.id,A);
  const save=(e:Exchange)=>pool.query('update pilot_exchanges set data=$2,revision=$3 where id=$1',[e.id,e,e.revision]);
  const command=async(actor:string,input:unknown)=>human?human(actor,input):service.command(actor,initial.id,randomUUID(),(await current()).revision,input);
  const op=async(kind:string):Promise<Operation>=>{
    const row=(await pool.query('select * from pilot_operations where exchange_id=$1 and kind=$2',[initial.id,kind])).rows[0];assert(row);
    return {id:row.id,exchangeId:row.exchange_id,mode:row.mode,kind:row.kind,version:row.version,state:row.state,attempts:row.attempts,
      providerId:row.provider_id,result:row.result,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
  };
  let postageRefunds=0,loseRefund=false,postageRefundStatus='PENDING';
  let purchases=0,refunds=0,paidChecks=0,labelId='',trackingStatus='PRE_TRANSIT',trackingTime=new Date().toISOString();
  let price='9.15',losePurchase=false,wrongIdentity=false,missingQr=false;
  const fact:PaymentFact={sessionId:'cs_return_fixture',status:'paid',amount:offer.buyerTotal,currency:'usd',paymentIntentId:'pi_return',
    chargeId:'ch_return',transferId:'tr_return',transferred:true,transferReversed:false,transferReversedAmount:0,
    refunded:false,refundedAmount:0,destinationPaymentId:'py_return',checkoutUrl:null};
  const config=providerConfig({},'live');
  class StripeFixture extends StripeProvider {
    override async retrieve() {paidChecks++;return {...fact};}
    override async refund(paymentIntentId:string,amount:number,key:string,reverse=true) {
      assert.equal(paymentIntentId,fact.paymentIntentId);assert.equal(amount,offer.buyerTotal);assert.equal(key,(await op('refund')).id);assert.equal(reverse,true);
      refunds++;fact.refunded=true;fact.refundedAmount=amount;fact.transferReversed=true;fact.transferReversedAmount=offer.item.sellerAmount+offer.quote.shippingAmount;
      return {id:'re_return',status:'succeeded',amount,currency:'usd' as const,payment_intent:paymentIntentId};
    }
  }
  const fetch:FetchLike=async(_url,init)=>{
    if(init?.method==='DELETE') return new Response(null,{status:200});
    if(init?.method==='GET') return new Response(null,{status:405});
    const message=JSON.parse(String(init?.body));if(message.id===undefined) return new Response(null,{status:202});
    let result:unknown;
    if(message.method==='initialize') result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'return-worker-fixture',version:'1'}};
    else if(message.method==='tools/list') result={tools};
    else {
      const {name,arguments:args}=message.params.arguments;let payload:unknown;
      const transaction={object_id:'return_transaction_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,
        metadata:shippoOperationMetadata(wrongIdentity?randomUUID():labelId),rate:quote.rateId,parcel:'return_parcel_fixture',status:'SUCCESS',
        tracking_number:'RETURN_TRACKING',label_file_type:'PDF',label_url:'https://deliver.goshippo.com/return.pdf?signature=PRIVATE_LABEL',
        ...(quote.artifact==='label_qr'&&!missingQr?{qr_code_url:'https://deliver.goshippo.com/return-qr.pdf?signature=PRIVATE_QR'}:{})};
      if(name==='GetRate') payload={object_id:quote.rateId,object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,object_created:new Date().toISOString(),
        shipment:quote.shipmentId,carrier_account:quote.carrierAccountId,provider:quote.carrier,servicelevel:{token:quote.service,name:'Ground'},amount:price,currency:'USD'};
      else if(name==='GetCarrierAccount') payload={object_id:quote.carrierAccountId,object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,active:true,carrier:quote.carrier.toLowerCase()};
      else if(name==='CreateTransaction') {
        purchases++;const saved=await op('return_label');assert.equal(saved.state,'running');assert.equal(saved.result?.effectStarted,true);assert(paidChecks>0);
        assert.deepEqual(args,{rate:quote.rateId,label_file_type:'PDF',metadata:shippoOperationMetadata(labelId),async:false});
        if(losePurchase) throw new Error('Synthetic lost return purchase response');payload=transaction;
      } else if(name==='GetTransaction') {assert.equal(args.TransactionId,'return_transaction_fixture');payload=transaction;}
      else if(name==='GetTrack') {
        assert.deepEqual(args,{Carrier:quote.carrier.toLowerCase(),TrackingNumber:'RETURN_TRACKING'});
        payload={carrier:quote.carrier.toLowerCase(),tracking_number:'RETURN_TRACKING',transaction:'return_transaction_fixture',
          tracking_status:{object_id:`return_${trackingStatus}`,object_updated:trackingTime,status_date:trackingTime,status:trackingStatus}};
      } else if(name==='CreateRefund' || name==='GetRefund') {
        if(name==='CreateRefund') {
          postageRefunds++;assert.deepEqual(args,{transaction:'return_transaction_fixture',async:false});
          assert.equal((await op('return_label_refund')).result?.effectStarted,true);
          if(loseRefund) throw new Error('Synthetic lost return refund response');
        } else assert.deepEqual(args,{RefundId:'return_refund_fixture'});
        payload={object_id:'return_refund_fixture',object_owner:'PRIVATE_ACCOUNT_CANARY',test:false,transaction:'return_transaction_fixture',status:postageRefundStatus};
      } else assert.fail(`Unexpected return operation ${name}`);
      result={content:[{type:'text',text:JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Response:payload})}]};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:message.id,result}),{headers:{'content-type':'application/json'}});
  };
  const driver=new ConnectedShipping(service,root,(url,invocation,before,_fetch,redact)=>executeMcp(url,invocation,before,fetch,redact));
  const shipping=new EasyPostProvider(config,async()=>{assert.fail('Return reached platform shipping');});
  const worker=()=>new CommerceWorker(repository,service,{stripe:new StripeFixture(config),shipping,connectedShipping:driver,locations:new FedExLocations(config)});
  const assets=new CommerceAssets(service,'https://example.supabase.co','fixture','private',shipping,driver,async(url,artifact)=>{
    assert(url.includes(quote.artifact==='label_qr'?'return-qr':'return.pdf'));assert.equal(artifact,quote.artifact);
    return {artifact,mime:'application/pdf',base64:Buffer.from('%PDF-fixture').toString('base64')};
  });
  try {
    for(const [name,fields] of Object.entries(connectedShippingContracts)) await describe(name,name.startsWith('Create')?'write':'read',fields);
    await assert.rejects(command(A,{type:'approve_return',binding:{...returnBinding(initial,A),amount:1}}),/stale/);
    const stale=structuredClone(initial);stale.returnPlan!.quote!.expiresAt='2020-01-01T00:00:00Z';await save(stale);
    await assert.rejects(command(A,{type:'approve_return',binding:returnBinding(stale,A)}));await save(initial);
    await command(A,{type:'approve_return',binding:returnBinding(await current(),A)});
    await assert.rejects(command(A,{type:'approve_return',binding:returnBinding(await current(),A)}),/duplicated/);
    assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='return_label'",[initial.id])).rows[0].n,0);
    await command(B,{type:'approve_return',binding:returnBinding(await current(),B)});labelId=(await op('return_label')).id;
    await assert.rejects(assets.label(A,initial.id,true),/No usable/);
    await pool.query("insert into pilot_operations(id,exchange_id,mode,kind,version,state,provider_id) values($1,$2,'live','checkout',$3,'succeeded','cs_return_fixture')",[randomUUID(),initial.id,offer.version]);
    // Original payment polling must not turn the agreed return into an early refund.
    await worker().applyPayment(await op('checkout'),fact);assert.equal((await current()).payment,'paid');
    assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='refund'",[initial.id])).rows[0].n,0);
    price='9.16';await worker().process(await op('return_label'));assert.equal(purchases,0);assert.equal((await op('return_label')).state,'failed');
    const failed=await current();
    assert((await service.get(B,initial.id)).operations.some(row=>row.returnRequoteAvailable));
    await command(A,{type:'refresh_return_quote'});
    assert.equal((await current()).returnPlan!.shipping,'none');assert.equal((await current()).returnPlan!.quote,null);
    assert.deepEqual((await current()).returnPlan!.approvals,[]);assert.equal((await op('return_label')).result?.cancelledNoLabel,true);
    await worker().process(await op('return_label'));assert.equal(purchases,0);
    // Restore this isolated fixture to exercise the separate uncertain path.
    await save(failed);await repository.transaction(sql=>repository.savePrivate(sql,initial,A,originalPrivate));
    await pool.query("update pilot_operations set state='failed',result='{}' where id=$1",[labelId]);
    price='9.15';await command(B,{type:'retry_operation',operationId:labelId,reason:'Exact rate restored; retry before any dispatch'});
    losePurchase=true;await worker().process(await op('return_label'));assert.equal(purchases,1);assert.equal((await op('return_label')).providerId,null);
    await assert.rejects(command(A,{type:'refresh_return_quote'}),/possible spending/);
    losePurchase=false;await worker().process(await op('return_label'));assert.equal(purchases,1,'Unknown outcome must not buy twice');
    await assert.rejects(command(A,{type:'attach_provider_reference',operationId:labelId,providerId:'return_transaction_fixture',reason:'Not my service account'}),/other participant/);
    await command(B,{type:'attach_provider_reference',operationId:labelId,providerId:'return_transaction_fixture',reason:'Located original seller purchase'});
    wrongIdentity=true;await worker().process(await op('return_label'));assert.equal((await current()).returnPlan!.shipping,'label_pending');wrongIdentity=false;
    await command(B,{type:'retry_operation',operationId:labelId,reason:'Reconcile original transaction evidence'});
    if(quote.artifact==='label_qr') {
      missingQr=true;await worker().process(await op('return_label'));assert.equal((await op('return_label')).providerId,'return_transaction_fixture');
      assert.equal((await current()).returnPlan!.shipping,'label_pending');missingQr=false;
      await command(B,{type:'retry_operation',operationId:labelId,reason:'Provider printing code is now available'});
    }
    await Promise.all([worker().process(await op('return_label')),worker().process(await op('return_label'))]);
    assert.equal(purchases,1);assert.equal((await current()).returnPlan!.shipping,'label_ready');
    assert.equal((await assets.label(A,initial.id,true)).mime,'application/pdf');await assert.rejects(assets.label(B,initial.id,true),/other participant/);
    const ready=await current(),readyRows=(await pool.query('select * from pilot_operations where exchange_id=$1',[initial.id])).rows;
    const restoreReady=async()=>{
      await pool.query('delete from pilot_operations where exchange_id=$1',[initial.id]);
      await pool.query('insert into pilot_operations select * from jsonb_populate_recordset(null::pilot_operations,$1::jsonb)',[JSON.stringify(readyRows)]);
      await save(ready);trackingStatus='PRE_TRANSIT';
    };
    for(const outcome of ['lost_then_success','rejected','carrier_used']) {
      await assert.rejects(command(A,{type:'cancel_return',binding:{...returnCancellationBinding(await current(),A),amount:1}}),/exact unused/);
      await command(A,{type:'cancel_return',binding:returnCancellationBinding(await current(),A)});
      await assert.rejects(command(B,{type:'withdraw_return_cancellation',binding:returnCancellationBinding(await current(),B)}),/Only your/);
      await command(A,{type:'withdraw_return_cancellation',binding:returnCancellationBinding(await current(),A)});
      assert.deepEqual((await current()).returnPlan!.cancelApprovedBy,[]);
      await command(A,{type:'cancel_return',binding:returnCancellationBinding(await current(),A)});
      await assert.rejects(assets.label(A,initial.id,true),/No usable/);
      await assert.rejects(command(A,{type:'return_dropped_off'}),/paid return label/);
      assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='return_label_refund'",[initial.id])).rows[0].n,0);
      await command(B,{type:'cancel_return',binding:returnCancellationBinding(await current(),B)});
      await assert.rejects(command(A,{type:'withdraw_return_cancellation',binding:returnCancellationBinding(await current(),A)}),/Only your/);
      const before=postageRefunds;
      if(outcome==='carrier_used') {
        trackingStatus='TRANSIT';await worker().process(await op('return_label_refund'));assert.equal(postageRefunds,before);
      } else if(outcome==='lost_then_success') {
        loseRefund=true;await worker().process(await op('return_label_refund'));loseRefund=false;
        await worker().process(await op('return_label_refund'));assert.equal(postageRefunds,before+1);
        await command(B,{type:'attach_provider_reference',operationId:(await op('return_label_refund')).id,providerId:'return_refund_fixture',reason:'Located original unused return postage refund'});
        postageRefundStatus='SUCCESS';await worker().process(await op('return_label_refund'));
        assert.equal((await current()).returnPlan!.shipping,'cancelled');assert.equal((await current()).payment,'paid');assert.equal(refunds,0);
        await worker().process(await op('return_label'));assert.equal(purchases,1);
        await command(A,{type:'propose_resolution',remedy:'refund',reason:'Choose a new remedy after cancelling the return'});
        await worker().applyPayment(await op('checkout'),fact);assert.equal((await current()).payment,'paid');assert.equal(refunds,0);
        assert.equal((await pool.query("select count(*)::int n from pilot_operations where exchange_id=$1 and kind='refund'",[initial.id])).rows[0].n,0);
      } else {
        postageRefundStatus='ERROR';await worker().process(await op('return_label_refund'));
        assert.equal((await op('return_label_refund')).result?.refundStatus,'rejected');
        await assert.rejects(command(A,{type:'accept_return_postage_cost',binding:returnCancellationBinding(await current(),A,'accept_return_postage_cost')}),/other participant/);
        await command(B,{type:'accept_return_postage_cost',binding:returnCancellationBinding(await current(),B,'accept_return_postage_cost')});
        assert.equal((await current()).returnPlan!.shipping,'cancelled');assert.equal((await current()).payment,'paid');assert.equal(refunds,0);
        assert.equal((await op('return_label_refund')).result?.costAccepted,true);
      }
      await restoreReady();
    }
    await assert.rejects(command(B,{type:'return_received'}),/delivery/);
    await command(A,{type:'return_dropped_off'});assert.equal((await current()).returnPlan!.carrierAcceptedAt,null);
    trackingStatus='TRANSIT';trackingTime=new Date(Date.now()+1000).toISOString();await worker().process(await op('return_label'));
    assert.equal((await current()).returnPlan!.shipping,'in_transit');
    trackingStatus='DELIVERED';trackingTime=new Date(Date.now()+2000).toISOString();await worker().process(await op('return_label'));
    assert.equal((await current()).returnPlan!.shipping,'delivered');assert.equal(refunds,0);
    trackingStatus='PRE_TRANSIT';trackingTime=new Date(Date.now()-5000).toISOString();await worker().process(await op('return_label'));
    assert.equal((await current()).returnPlan!.shipping,'delivered');
    await assert.rejects(command(A,{type:'return_received'}),/other participant/);
    await command(B,{type:'return_received'});await worker().process(await op('refund'));await worker().process(await op('refund'));
    assert.equal(refunds,1);assert.equal((await current()).payment,'refunded');assert.equal((await current()).transfer,'reversed');assert.equal(purchases,1);
    process.stdout.write(`PASS: seller-absorbed ${quote.artifact} return, exact two-owner approvals, no early Stripe refund, stale/rate/owner guards, uncertain purchase recovery without duplicates, private buyer artifact, monotonic tracking, full original refund/reversal, never-dispatched refresh, two-owner unused cancellation, withdrawal, lost refund recovery, carrier-used denial and seller cost acceptance; synthetic providers.\n`);
  } finally {
    await pool.query('delete from pilot_operations where exchange_id=$1',[initial.id]);
    await pool.query('insert into pilot_operations select * from jsonb_populate_recordset(null::pilot_operations,$1::jsonb)',[JSON.stringify(originalRows)]);
    await save(initial);await repository.transaction(sql=>repository.savePrivate(sql,initial,A,originalPrivate));
  }
}
