import type { Exchange, PrivateInput } from './domain.js';

/** Deterministic prerequisites for the model's next decision. A plan or
 * recommendation cannot change these facts or establish provider outcomes. */
export function harnessContext(e: Exchange, actor: string, mine: PrivateInput, buyer: PrivateInput, seller: PrivateInput, now=new Date(),connectedShippingEnabled=false) {
  const buyerRole = actor === e.buyerId;
  const missing: string[] = [];
  if (!e.requestShared) missing.push('owner_share_approval');
  else if (!e.item) missing.push(buyerRole ? 'seller_item_confirmation' : 'ask_owner_about_item');
  if (e.item && e.payment === 'unpaid') {
    if (!mine.address) missing.push('owner_private_address_form');
    if (!(buyerRole ? seller.address : buyer.address)) missing.push('counterparty_private_address');
    if (!seller.packing) missing.push(buyerRole ? 'seller_packing' : 'owner_packing');
    const quote=e.offers.at(-1)?.quote;
    const printingCodeSupported=quote?.artifact==='label_qr' && quote.dropoff.artifact==='label_qr'
      && quote.dropoff.carrier===quote.carrier && quote.dropoff.service===quote.service
      && Date.parse(quote.expiresAt)>now.getTime() && quote.originVersion===seller.addressVersion
      && quote.destinationVersion===buyer.addressVersion && quote.packingVersion===seller.packingVersion;
    if (seller.packing && !seller.packing.canPrint && !printingCodeSupported) missing.push('supported_no_printer_fulfillment');
    if (!e.offers.length || e.stage === 'preparing_offer') missing.push('verified_fulfillment_option');
    if(e.offers.at(-1)?.connectedShipping && (!connectedShippingEnabled || e.mode!=='live')) missing.push('connected_shipping_execution');
    if (e.stage === 'offered' && !e.approvals.some(a=>a.actorId===actor)) missing.push('owner_exact_offer_approval');
    if (e.stage === 'offered' && e.approvals.length < 2) missing.push('both_exact_offer_approvals');
  }
  if (e.payment === 'pending') missing.push(buyerRole ? 'owner_hosted_payment' : 'confirmed_buyer_payment');
  if (e.payment === 'paid' && e.shipping === 'label_pending') missing.push('provider_postage_confirmation');
  if (e.shipping === 'label_ready' && !e.sellerDroppedAt) missing.push(buyerRole ? 'seller_physical_handoff' : 'owner_physical_handoff');
  if (e.shipping === 'in_transit') missing.push('carrier_delivery');
  if (e.shipping === 'delivered' && !e.buyerReceivedAt) missing.push(buyerRole ? 'owner_receipt_confirmation' : 'buyer_receipt_confirmation');
  if(e.returnPlan) {
    if(e.returnPlan.shipping==='none') {
      if(!buyer.returnPacking) missing.push(buyerRole?'owner_return_packing':'buyer_return_packing');
      if(e.shippingData?.journey!=='return' || e.shippingData.declined
        || Date.parse(e.shippingData.expiresAt)<=now.getTime()
        || ![e.buyerId,e.sellerId].every(id=>e.shippingData!.approvedBy.includes(id))) missing.push('return_shipping_data_permission');
      if(!e.returnPlan.quote) missing.push('verified_return_shipping_option');
    }
    if(e.returnPlan.shipping==='label_pending') missing.push('provider_return_postage_confirmation');
    if(e.returnPlan.shipping==='label_ready' && !e.returnPlan.droppedAt) missing.push(buyerRole?'owner_return_handoff':'buyer_return_handoff');
    if(e.returnPlan.shipping==='in_transit') missing.push('return_carrier_delivery');
    if(e.returnPlan.shipping==='delivered' && !e.returnPlan.receivedAt) missing.push(buyerRole?'seller_return_receipt':'owner_return_receipt');
  }
  if (e.problem || e.stage === 'needs_attention') missing.push('resolution');
  const closed = ['cancelled', 'declined', 'expired', 'completed'].includes(e.stage);
  return {
    missing: closed ? [] : missing, closed,
    privateBudget: mine.budget,
    inputs: { ownerAddressProvided: !!mine.address, bothAddressesProvided: !!buyer.address && !!seller.address,
      sellerPackingProvided: !!seller.packing, sellerCanPrint: seller.packing?.canPrint ?? null,
      returnPackingProvided:!!buyer.returnPacking,returnSenderCanPrint:buyer.returnPacking?.canPrint ?? null },
    preparedAction: mine.agentAction ?? null,
    discoveryAreaProvided: !!mine.discoveryPostcode,
    authority: 'Prepare one specific action for review, then stop. Human approvals and provider facts are checked independently.',
  };
}
