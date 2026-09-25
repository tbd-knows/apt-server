import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { RunContext } from '../memory/domain.js';
import {
  approve, approvalFor, conflict, createExchange, currentOffer, digest, draftRequestSchema,
  exchangeView, humanCommandSchema, invalidate, itemSchema, mutable, requireRole,
  reconciledStage, resolutionBinding, returnBinding, stableJson, type Exchange, type Mode, type Quote,
  preparedCommandSchema,
} from './domain.js';
import { CommerceRepository, emptyPrivateInput } from './repository.js';
import { harnessContext } from './harness.js';
import { CommerceResearch, researchInputSchema } from './research.js';
import { listConnections } from './connections.js';
import { listServiceActions,prepareServiceAction,serviceActionSchema,serviceActionHistory,serviceHistorySchema } from './service-actions.js';
import { proposeShippingData, decideShippingData, shippingDataView } from './shipping-consent.js';
import { prepareShippingValidation,shippingValidationSchema } from './shipping-validation.js';
import { prepareShippingRates,shippingRatesSchema } from './shipping-rates.js';

export class CommerceService {
  get research() { return new CommerceResearch(this); }
  constructor(readonly repository: CommerceRepository, readonly founders: readonly string[], readonly mode: Mode,
    private readonly now: () => Date = () => new Date()) {
    if (founders.length !== 2 || new Set(founders).size !== 2 || founders.some(id => !z.uuid().safeParse(id).success)) {
      throw new Error('Configure exactly two distinct Auth UUIDs.');
    }
  }
  authorize(actor: string) {
    if (!this.founders.includes(actor)) throw new AppError('FORBIDDEN', 'This pilot is limited to the two configured founders.');
  }
  counterpart(actor: string) { this.authorize(actor); return this.founders.find(id => id !== actor)!; }
  async list(actor: string) {
    this.authorize(actor);
    return { mode: this.mode, exchanges: (await this.repository.list(actor)).filter(e => e.mode === this.mode).map(e => exchangeView(e, actor)) };
  }
  async get(actor: string, id: string) {
    this.authorize(actor);
    const e = await this.repository.get(id, actor);
    if (e.mode !== this.mode) throw new AppError('NOT_FOUND', 'Exchange not found in this mode.');
    const view = exchangeView(e, actor);
    const execution = await this.repository.pool.query<{ result: { checkoutUrl?: string } }>(
      "select result from pilot_operations where exchange_id=$1 and kind='checkout' and state='succeeded' order by version desc limit 1", [id]);
    const checkoutUrl = execution.rows[0]?.result?.checkoutUrl ?? null;
    const operations = (await this.repository.pool.query(`select id,kind,state,attempts,provider_id as "providerId",
      case when kind='label_refund' then result->>'refundStatus' else null end as "labelRefundStatus"
      from pilot_operations where exchange_id=$1 order by created_at`, [id])).rows;
    return { ...view, requestDigest: digest(e.request), privateInput: await this.repository.privateInput(e, actor),
      shippingData: await shippingDataView(this,e,actor,this.now()),
      operations, deliveries: await this.deliveries(actor, id), research: await this.research.list(actor,id),connections:await listConnections(this,actor,id),serviceActions:await listServiceActions(this,actor,id),
      execution: { checkoutUrl: actor === e.buyerId && e.payment === 'pending' && !e.cancellationRequested && checkoutUrl?.startsWith('https://checkout.stripe.com/') ? checkoutUrl : null,
        returnLabelAvailable: actor === e.buyerId && !!e.returnPlan && ['label_ready','in_transit','delivered'].includes(e.returnPlan.shipping),
        labelAvailable: actor === e.sellerId && e.payment === 'paid' && !e.cancellationRequested && ['label_ready','in_transit','delivered'].includes(e.shipping) } };
  }
  async create(actor: string, key: string, raw: unknown) {
    this.authorize(actor);
    const input = draftRequestSchema.parse(raw);
    const id = await this.repository.transaction(async sql => {
      const previous = await this.repository.previousCommand(sql, actor, key, input);
      if (previous) return previous;
      const e = createExchange(actor, this.counterpart(actor), this.mode, input.request, this.now());
      await this.repository.insert(sql, e);
      await this.repository.savePrivate(sql, e, actor, { ...emptyPrivateInput(), budget: input.privateBudget });
      await this.repository.message(sql, e, actor, actor, 'status', { action: 'share_request', request: e.request });
      await this.repository.recordCommand(sql, actor, key, input, e.id);
      await this.repository.event(sql, e, actor, 'draft_request', { revision: e.revision });
      return e.id;
    });
    return this.get(actor, id);
  }

  async command(actor: string, id: string, key: string, revision: number, raw: unknown) {
    this.authorize(actor);
    const requested = humanCommandSchema.parse(raw);
    const input = { id, revision, command: requested };
    await this.repository.transaction(async sql => {
      if (await this.repository.previousCommand(sql, actor, key, input)) return;
      const e = await this.repository.get(id, actor, sql, true);
      exchangeView(e, actor); // Also enforces draft visibility.
      if (e.mode !== this.mode) throw new AppError('NOT_FOUND', 'Exchange not found in this mode.');
      if (e.revision !== revision) conflict('This action changed. Refresh before deciding.');
      const now = this.now();
      const other = this.counterpart(actor);
      let command = requested;
      if (requested.type === 'approve_agent_action') {
        const data = await this.repository.privateInput(e, actor, sql);
        const action = data.agentAction;
        if (!action || action.id !== requested.actionId || action.digest !== requested.actionDigest
          || action.revision !== e.revision || Date.parse(action.expiresAt) <= now.getTime()) conflict('The prepared action changed or expired. Ask your agent to prepare it again.');
        command = preparedCommandSchema.parse(action.command);
        delete data.agentAction;
        await this.repository.savePrivate(sql, e, actor, data);
        await this.repository.event(sql, e, actor, 'agent_action_approved', { actionId: action.id, digest: action.digest, command: action.command });
      }
      switch (command.type) {
        case 'propose_shipping_data':
          await proposeShippingData(this,sql,e,actor,command.connectionId,now);
          break;
        case 'decide_shipping_data':
          await decideShippingData(this,sql,e,actor,command.consentId,command.consentDigest,command.approve,command.acknowledgeServiceAccountAccess,now);
          break;
        case 'decide_mcp_inspection': {
          mutable(e,now);
          const data = await this.repository.privateInput(e,actor,sql);
          const result = await sql.query(`select * from pilot_research where id=$1 and exchange_id=$2 and owner_id=$3
            and mode=$4 and kind='inspect_mcp' and state='awaiting_approval' for update`,[command.researchId,e.id,actor,e.mode]);
          const row = result.rows[0];
          if (!row || row.input.addressVersion!==(data.discoveryVersion ?? 0)
            || command.inspectionDigest!==digest({id:row.id,endpoint:row.input.url,owner:actor,area:row.input.addressVersion})) conflict('Inspection request changed or is no longer available.');
          await sql.query("update pilot_research set state=$2,approved_at=$3,updated_at=now() where id=$1",
            [row.id,command.approve ? 'pending' : 'declined',command.approve ? now : null]);
          break;
        }
        case 'research_area': {
          mutable(e,now);
          const data = await this.repository.privateInput(e,actor,sql);
          data.discoveryPostcode = command.postcode;
          data.discoveryVersion = (data.discoveryVersion ?? 0) + 1;
          await this.repository.savePrivate(sql,e,actor,data);
          break;
        }
        case 'retry_research': {
          mutable(e,now);
          const mine = await this.repository.privateInput(e,actor,sql);
          const result = await sql.query(`update pilot_research set state='pending',attempts=2,lease_id=null,updated_at=now()
            where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4 and state='failed'
            and input->>'addressVersion'=$5 returning id`,[command.researchId,e.id,actor,e.mode,String(mine.discoveryVersion ?? 0)]);
          if (!result.rowCount) conflict('Only your failed research can be retried.');
          break;
        }
        case 'dismiss_agent_action': {
          const data = await this.repository.privateInput(e, actor, sql);
          if (data.agentAction?.id !== command.actionId) conflict('Prepared action not found.');
          delete data.agentAction;
          await this.repository.savePrivate(sql, e, actor, data);
          break;
        }
        case 'share_request':
          requireRole(e, actor, 'buyer'); mutable(e, now);
          if (e.requestShared || command.requestDigest !== digest(e.request)) conflict('The request changed or is already shared.');
          e.requestShared = true; e.stage = 'waiting_for_seller';
          await this.repository.message(sql, e, actor, other, 'request', e.request);
          break;
        case 'decline':
          requireRole(e, actor, 'seller'); mutable(e, now);
          e.stage = 'declined'; e.approvals = [];
          await this.repository.message(sql, e, actor, other, 'decline', { reason: command.reason });
          break;
        case 'share_item': {
          requireRole(e, actor, 'seller'); mutable(e, now);
          if (!e.requestShared) conflict('The request has not been shared.');
          const assets = await sql.query(`select id from public.pilot_assets where id=any($1::uuid[])
            and owner_id=$2 and exchange_id=$3 and kind='photo' and state='ready'`, [command.item.photoIds, actor, e.id]);
          if (assets.rowCount !== command.item.photoIds.length || new Set(command.item.photoIds).size !== command.item.photoIds.length) {
            conflict('Only your uploaded photos for this exchange can be shared.');
          }
          const item = await sql.query(`insert into public.pilot_items(id,seller_id,mode,details) values($1,$2,$3,$4)
            on conflict(id) do update set details=excluded.details
            where pilot_items.seller_id=excluded.seller_id and pilot_items.mode=excluded.mode
              and pilot_items.reserved_by is null and pilot_items.sold=false returning id`,
          [command.item.itemId, actor, e.mode, command.item]);
          if (!item.rowCount) conflict('This item belongs to another seller or is already reserved.');
          e.item = command.item; e.itemDraft = null; invalidate(e);
          if (++e.negotiationTurns > 12) conflict('Negotiation limit reached. Start a new request after agreeing on terms.');
          await this.repository.message(sql, e, actor, other, 'seller_response', command.item);
          break;
        }
        case 'address': {
          mutable(e, now);
          const data = await this.repository.privateInput(e, actor, sql);
          data.address = command.address; data.addressVersion += 1;
          delete data.suggestedAddress;
          await this.repository.savePrivate(sql, e, actor, data);
          if (e.item) invalidate(e);
          break;
        }
        case 'packing': {
          requireRole(e, actor, 'seller'); mutable(e, now);
          const data = await this.repository.privateInput(e, actor, sql);
          data.packing = command.packing; data.packingVersion += 1;
          await this.repository.savePrivate(sql, e, actor, data);
          if (e.item) invalidate(e);
          break;
        }
        case 'quote': {
          mutable(e, now);
          if (!e.item) conflict('The seller must approve the real item and photos first.');
          const buyer = await this.repository.privateInput(e, e.buyerId, sql);
          const seller = await this.repository.privateInput(e, e.sellerId, sql);
          if (!buyer.address || !seller.address || !seller.packing) conflict('Both addresses and the packed dimensions are required.');
          if (!seller.packing.canPrint) conflict('A supported printing path is needed before requesting this PDF shipping offer.');
          invalidate(e);
          await this.repository.enqueue(sql, e, 'quote', e.revision + 1);
          await sql.query("update pilot_operations set result=$3 where exchange_id=$1 and kind='quote' and version=$2", [e.id, e.revision + 1,
            { inputHash: digest({ item: e.item, buyer: buyer.addressVersion, seller: seller.addressVersion, packing: seller.packingVersion }) }]);
          break;
        }
        case 'approve': {
          approve(e, actor, command.binding, now);
          const binding = approvalFor(e, actor);
          await sql.query(`insert into public.pilot_approvals(id,exchange_id,actor_id,version,binding) values($1,$2,$3,$4,$5)`,
            [randomUUID(), e.id, actor, binding.version, binding]);
          break;
        }
        case 'checkout': {
          requireRole(e, actor, 'buyer');
          const offer = currentOffer(e);
          if (e.stage !== 'offered' || e.approvals.length !== 2 || e.approvals.some(a => a.digest !== digest(offer))) conflict('Both people must approve the current offer.');
          if (Date.parse(offer.expiresAt) <= now.getTime() + 31 * 60_000) conflict('The quote is too close to expiry. Refresh the offer before checkout.');
          const buyer = await this.repository.privateInput(e, actor, sql);
          if (buyer.budget === null || buyer.budget < offer.buyerTotal) conflict('The total exceeds your private all-in budget.');
          await this.repository.reserve(sql, e, offer.expiresAt);
          e.stage = 'awaiting_payment'; e.payment = 'pending';
          await this.repository.enqueue(sql, e, 'checkout', offer.version);
          break;
        }
        case 'cancel':
          if (['completed', 'cancelled', 'declined', 'expired'].includes(e.stage)) conflict('This exchange is already closed.');
          e.cancellationRequested = true;
          if (['in_transit', 'delivered', 'exception'].includes(e.shipping) || e.sellerDroppedAt) {
            e.stage = 'needs_attention'; e.problem = 'Cancellation after handoff requires a recorded founder resolution.';
          } else if (e.payment === 'paid') {
            e.stage = 'needs_attention'; e.payment = 'refund_pending';
            await this.repository.enqueue(sql, e, 'refund', currentOffer(e).version);
          } else if (e.payment === 'pending') {
            e.stage = 'needs_attention';
            await this.repository.enqueue(sql, e, 'cancel_checkout', currentOffer(e).version);
          } else if (e.payment === 'unpaid' || e.payment === 'failed') e.stage = 'cancelled';
          await this.repository.message(sql, e, actor, other, 'status', { action: 'cancel_requested', reason: command.reason });
          break;
        case 'dropped_off':
          requireRole(e, actor, 'seller');
          if (e.payment !== 'paid' || e.shipping !== 'label_ready' || e.cancellationRequested) conflict('Paid postage is required before drop-off.');
          e.sellerDroppedAt = now.toISOString();
          break;
        case 'received':
          requireRole(e, actor, 'buyer');
          if (e.shipping !== 'delivered' || e.payment !== 'paid') conflict('Carrier delivery and payment must be reconciled first.');
          e.buyerReceivedAt = now.toISOString();
          reconciledStage(e);
          break;
        case 'retry_delivery': {
          const retried = await sql.query(`update pilot_messages set a2a_attempts=4,a2a_attempted_at=null
            where id=$1 and exchange_id=$2 and sender_id=$3 and sender_id<>recipient_id
            and a2a_received_at is null and a2a_attempts>=5 and a2a_attempted_at<now()-interval '60 seconds' returning id`,
          [command.messageId, e.id, actor]);
          if (!retried.rowCount) conflict('Only your stalled outgoing messages can be retried after the current attempt finishes.');
          break;
        }
        case 'retry_operation':
        case 'attach_provider_reference': {
          const row = await sql.query('select * from pilot_operations where id=$1 and exchange_id=$2 and mode=$3 for update', [command.operationId, e.id, e.mode]);
          const op = row.rows[0];
          if (!op || !['failed','uncertain'].includes(op.state)) conflict('Only an operation needing attention can be reconciled.');
          if (command.type === 'attach_provider_reference') {
            if (!['quote','return_quote','checkout'].includes(op.kind) || op.provider_id || !command.providerId.startsWith(op.kind === 'checkout' ? 'cs_' : 'shp_')) conflict('This operation cannot accept that provider reference.');
            await sql.query('update pilot_operations set provider_id=$2 where id=$1', [op.id, command.providerId]);
          }
          // Preserve effectStarted and the attempt history. A human retry opens only
          // one more reconciliation attempt, never a fresh uncertain label purchase.
          await sql.query("update pilot_operations set state='uncertain',attempts=least(attempts,4),updated_at=now()-interval '10 minutes' where id=$1", [op.id]);
          await this.repository.event(sql, e, actor, 'operator_reconciliation', { operationId: op.id, reason: command.reason, providerId: command.type === 'attach_provider_reference' ? command.providerId : op.provider_id });
          break;
        }
        case 'propose_resolution':
          if (e.returnPlan && e.returnPlan.shipping !== 'none') conflict('Reconcile the existing return before changing its resolution.');
          if (!e.problem && !e.cancellationRequested && !Object.keys(e.operationIssues ?? {}).length) conflict('Report a problem before proposing a resolution.');
          if (!(command.remedy === 'absorb_postage' && e.payment === 'refunded') && !['paid','refund_failed'].includes(e.payment)) conflict('Reconcile payment before proposing a resolution.');
          e.resolution = { id: randomUUID(), remedy: command.remedy, reason: command.reason, offerDigest: digest(currentOffer(e)),
            amount: command.remedy === 'absorb_postage' ? currentOffer(e).quote.shippingAmount : currentOffer(e).buyerTotal, currency: 'USD', expiresAt: new Date(now.getTime() + 86400000).toISOString(), approvedBy: [] };
          await this.repository.message(sql, e, actor, other, 'status', { action: 'resolution', text: command.reason });
          break;
        case 'approve_resolution': {
          const proposal = e.resolution;
          if (!proposal || Date.parse(proposal.expiresAt) <= now.getTime() || proposal.offerDigest !== digest(currentOffer(e))
            || stableJson(command.binding) !== stableJson(resolutionBinding(e, actor))) conflict('The resolution changed or expired.');
          if (proposal.approvedBy.includes(actor)) conflict('You already approved this resolution.');
          proposal.approvedBy.push(actor);
          if (proposal.approvedBy.length === 2) {
            if (proposal.remedy === 'absorb_postage') {
              if (e.payment !== 'refunded') conflict('Reconcile the buyer refund first.');
              const rejected = await sql.query("select id from pilot_operations where exchange_id=$1 and kind='label_refund' and result->>'refundStatus'='rejected'", [e.id]);
              if (!rejected.rowCount) conflict('A canonical rejected unused-label refund is required.');
              for (const row of rejected.rows) {
                await sql.query("update pilot_operations set state='succeeded',result=result||'{\"costAccepted\":true}'::jsonb where id=$1", [row.id]);
                if (e.operationIssues) delete e.operationIssues[row.id];
              }
              e.problem = null; reconciledStage(e);
            } else if (proposal.remedy === 'refund') {
              e.cancellationRequested = true; e.payment = 'refund_pending';
              await this.repository.enqueue(sql, e, 'refund', currentOffer(e).version);
              await sql.query("update pilot_operations set state='uncertain',attempts=least(attempts,4),updated_at=now()-interval '10 minutes' where exchange_id=$1 and kind='refund' and state='failed'", [e.id]);
            } else if (proposal.remedy === 'resume') {
              const refund = await sql.query("select id from pilot_operations where exchange_id=$1 and kind='refund'", [e.id]);
              if (refund.rowCount || e.payment !== 'paid') conflict('A refund operation must reconcile before fulfillment can resume.');
              e.problem = null; e.cancellationRequested = false; reconciledStage(e);
            } else {
              if (!e.carrierAcceptedAt && !e.sellerDroppedAt) conflict('Use pre-shipment cancellation when the item has not been handed off.');
              e.cancellationRequested = true;
              e.returnPlan = { resolutionId: proposal.id, version: 0, quote: null, subsidy: '', approvals: [], shipping: 'none',
                droppedAt: null, carrierAcceptedAt: null, trackingUpdatedAt: null, receivedAt: null };
              e.problem = 'Return agreed. Prepare and approve a separate return shipping quote before buying return postage.';
            }
          }
          break;
        }
        case 'return_packing': {
          requireRole(e, actor, 'buyer');
          if (!e.returnPlan || e.returnPlan.shipping !== 'none') conflict('Return packing cannot change after postage is queued.');
          const data = await this.repository.privateInput(e, actor, sql);
          data.returnPacking = command.packing; data.returnPackingVersion = (data.returnPackingVersion ?? 0) + 1;
          await this.repository.savePrivate(sql, e, actor, data);
          e.returnPlan.quote = null; e.returnPlan.approvals = [];
          break;
        }
        case 'return_quote': {
          if (!e.returnPlan || e.returnPlan.shipping !== 'none' || e.resolution?.id !== e.returnPlan.resolutionId) conflict('A mutually agreed return is required.');
          const data = await this.repository.privateInput(e, e.buyerId, sql);
          if (!data.returnPacking?.canPrint) conflict('Confirm return packing and access to a printer first.');
          const destination = await this.repository.privateInput(e, e.sellerId, sql);
          e.returnPlan.quote = null; e.returnPlan.approvals = [];
          await this.repository.enqueue(sql, e, 'return_quote', e.revision + 1);
          await sql.query("update pilot_operations set result=$3 where exchange_id=$1 and kind='return_quote' and version=$2", [e.id, e.revision + 1,
            { inputHash: digest({ resolutionId: e.returnPlan.resolutionId, destination: destination.addressVersion, origin: data.addressVersion, packing: data.returnPackingVersion }) }]);
          break;
        }
        case 'approve_return': {
          const plan = e.returnPlan;
          if (!plan?.quote || plan.shipping !== 'none' || e.resolution?.id !== plan.resolutionId || plan.approvals.includes(actor)
            || Date.parse(plan.quote.expiresAt) <= now.getTime() || stableJson(command.binding) !== stableJson(returnBinding(e, actor))) conflict('Return approval is stale, duplicated or does not match.');
          plan.approvals.push(actor);
          if (plan.approvals.length === 2) { plan.shipping = 'label_pending'; await this.repository.enqueue(sql, e, 'return_label', plan.version); }
          break;
        }
        case 'return_dropped_off':
          requireRole(e, actor, 'buyer');
          if (e.returnPlan?.shipping !== 'label_ready') conflict('A paid return label is required.');
          e.returnPlan.droppedAt = now.toISOString();
          break;
        case 'return_received':
          requireRole(e, actor, 'seller');
          if (e.returnPlan?.shipping !== 'delivered' || !e.returnPlan.approvals.includes(actor)) conflict('Reconcile return delivery before confirming receipt.');
          e.returnPlan.receivedAt = now.toISOString(); e.payment = 'refund_pending';
          await this.repository.enqueue(sql, e, 'refund', currentOffer(e).version);
          break;
        case 'problem':
          e.problem = command.reason; e.stage = 'needs_attention';
          await this.repository.message(sql, e, actor, other, 'status', { action: 'problem', reason: command.reason });
          break;
        case 'message':
          mutable(e, now);
          if (!e.requestShared || ++e.negotiationTurns > 12) conflict('This exchange cannot accept more negotiation messages.');
          if (command.kind === 'counteroffer') invalidate(e);
          await this.repository.message(sql, e, actor, other, command.kind, { text: command.text, untrusted: true });
          break;
      }
      await this.repository.save(sql, e, now);
      await this.repository.event(sql, e, actor, command.type, { revision: e.revision });
      // Human decisions resume the same private agent through the durable inbox.
      // No provider side effect is repeated by this wake-up.
      if (command.type !== 'retry_delivery') await this.repository.message(sql, e, actor, actor, 'status', { action: 'owner_update', revision: e.revision });
      await this.repository.recordCommand(sql, actor, key, input, id);
    });
    return this.get(actor, id);
  }

  /** Called only with a provider-adapter quote, never model/client arguments. */
  async publishQuote(id: string, expectedRevision: number, quote: Quote, economics: { taxAmount: number; feeAmount: number; subsidy: string; taxTreatment: string }) {
    await this.repository.transaction(async sql => {
      const row = await sql.query<{ data: Exchange }>('select data from public.pilot_exchanges where id=$1 for update', [id]);
      const e = row.rows[0]?.data;
      if (!e || e.revision !== expectedRevision || !e.item) conflict('Shipping inputs changed while fetching the rate.');
      mutable(e, this.now());
      const buyer = await this.repository.privateInput(e, e.buyerId, sql);
      const seller = await this.repository.privateInput(e, e.sellerId, sql);
      if (quote.destinationVersion !== buyer.addressVersion || quote.originVersion !== seller.addressVersion || quote.packingVersion !== seller.packingVersion) conflict('Address or package changed.');
      const amounts = [e.item.sellerAmount, quote.shippingAmount, economics.taxAmount, economics.feeAmount];
      if (amounts.some(v => !Number.isSafeInteger(v) || v < 0) || amounts.reduce((a, b) => a + b, 0) > 1_000_000) conflict('Invalid quote amounts.');
      if (Date.parse(quote.expiresAt) <= this.now().getTime() || quote.currency !== 'USD') conflict('Rate is expired or unsupported.');
      const offer = {
        version: e.offers.length + 1, item: structuredClone(e.item), quote, ...economics,
        buyerTotal: amounts.reduce((a, b) => a + b, 0), currency: 'USD' as const, expiresAt: quote.expiresAt,
        shipBy: new Date(this.now().getTime() + 3 * 86_400_000).toISOString(),
      };
      e.offers.push(offer); e.approvals = []; e.stage = 'offered';
      const oldQuotes = await sql.query("select id from pilot_operations where exchange_id=$1 and kind='quote'", [e.id]);
      for (const row of oldQuotes.rows) if (e.operationIssues) delete e.operationIssues[row.id];
      await this.repository.save(sql, e, this.now());
      for (const recipient of [e.buyerId, e.sellerId]) await this.repository.message(sql, e, e.sellerId, recipient, 'offer', offer);
    });
  }

  async inbox(actor: string) {
    this.authorize(actor);
    const r = await this.repository.pool.query(`select m.id,m.exchange_id as "exchangeId",m.kind,m.payload,
      m.created_at as "createdAt",m.read_at as "readAt" from public.pilot_messages m
      join public.pilot_exchanges e on e.id=m.exchange_id where m.recipient_id=$1 and e.mode=$2
      order by m.created_at desc limit 100`, [actor, this.mode]);
    return r.rows;
  }
  async readMessage(actor: string, id: string) {
    this.authorize(actor);
    await this.repository.pool.query('update public.pilot_messages set read_at=coalesce(read_at,now()) where id=$1 and recipient_id=$2', [id, actor]);
  }
  async pendingAgentMessages() {
    // Each isolated agent can run one turn. A global oldest-ten queue lets a
    // busy/unavailable founder's backlog starve the other founder indefinitely.
    // Select each owner's oldest eligible wake independently, preserving order.
    return (await this.repository.pool.query<{ id: string; recipient_id: string; exchange_id: string }>(`select distinct on (m.recipient_id) m.id,m.recipient_id,m.exchange_id from pilot_messages m
      join pilot_exchanges e on e.id=m.exchange_id where m.agent_delivered_at is null
      and (m.sender_id<>m.recipient_id or m.kind='offer' or m.payload->>'action' in ('provider_update','owner_update','research_update','connection_update','service_action_update','shipping_data_update'))
      and (m.sender_id=m.recipient_id or m.a2a_received_at is not null)
      and m.recipient_id=any($2::uuid[]) and e.buyer_id=any($2::uuid[]) and e.seller_id=any($2::uuid[])
      and e.mode=$1 order by m.recipient_id,m.created_at,m.id`, [this.mode,this.founders])).rows;
  }
  async deliveries(actor: string, exchangeId: string) {
    this.authorize(actor);
    return (await this.repository.pool.query(`select m.id,m.kind,m.a2a_received_at as "receivedAt",
      case when m.a2a_received_at is not null then 'received'
        when m.a2a_attempts>=5 and m.a2a_attempted_at<now()-interval '60 seconds' then 'needs_attention'
        else 'pending' end as state
      from pilot_messages m join pilot_exchanges e on e.id=m.exchange_id
      where m.exchange_id=$1 and m.sender_id=$2 and m.recipient_id<>m.sender_id and e.mode=$3
      order by m.created_at desc limit 20`, [exchangeId, actor, this.mode])).rows;
  }
  async markAgentDelivered(id: string) {
    await this.repository.pool.query('update pilot_messages set agent_delivered_at=now() where id=$1', [id]);
  }
  async preferences(actor: string) {
    this.authorize(actor);
    return (await this.repository.pool.query("select key,value,provenance,status,updated_at as \"updatedAt\" from public.pilot_preferences where owner_id=$1 and status<>'forgotten' order by key limit 100", [actor])).rows;
  }
  async preference(actor: string, raw: unknown, inferred = false) {
    this.authorize(actor);
    const input = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/), value: z.string().trim().min(1).max(500).nullable(), provenance: z.string().trim().min(1).max(500) }).strict().parse(raw);
    if (input.value === null) {
      if (inferred) conflict('Only the owner may forget a preference.');
      await this.repository.pool.query(`insert into public.pilot_preferences(owner_id,key,value,provenance,status) values($1,$2,'','Owner requested forgetting','forgotten')
        on conflict(owner_id,key) do update set value='',provenance='Owner requested forgetting',status='forgotten',updated_at=now()`, [actor, input.key]);
    } else await this.repository.pool.query(`insert into public.pilot_preferences(owner_id,key,value,provenance,status) values($1,$2,$3,$4,$5)
      on conflict(owner_id,key) do update set value=excluded.value,provenance=excluded.provenance,status=excluded.status,updated_at=now()
      where pilot_preferences.status = 'inferred' or excluded.status='confirmed'`, [actor, input.key, input.value, input.provenance, inferred ? 'inferred' : 'confirmed']);
    return this.preferences(actor);
  }

  async invoke(context: RunContext, raw: unknown) {
    this.authorize(context.userId);
    const command = z.discriminatedUnion('action', [
      z.object({ action: z.literal('state'), exchangeId: z.uuid().optional() }).strict(),
      z.object({ action: z.literal('suggest_preference'), key: z.string(), value: z.string(), provenance: z.string() }).strict(),
      z.object({ action: z.literal('draft_request'), input: draftRequestSchema }).strict(),
      z.object({ action: z.literal('draft_item'), exchangeId: z.uuid(), item: itemSchema }).strict(),
      z.object({ action: z.literal('ask_owner'), exchangeId: z.uuid(), question: z.string().min(1).max(500) }).strict(),
      z.object({ action: z.literal('prepare_action'), exchangeId: z.uuid(), revision: z.number().int().positive(),
        command: preparedCommandSchema, explanation: z.string().trim().min(1).max(500) }).strict(),
      z.object({ action: z.literal('research'), exchangeId: z.uuid(), research: researchInputSchema }).strict(),
      serviceActionSchema,serviceHistorySchema,
      shippingValidationSchema,shippingRatesSchema,
    ]).parse(raw);
    const actor = context.userId;
    if (command.action === 'state') {
      const records = command.exchangeId ? [await this.repository.get(command.exchangeId, actor)] : (await this.repository.list(actor)).filter(e=>e.mode===this.mode).slice(0, 5);
      const exchanges = await Promise.all(records.map(async e => {
        const view = exchangeView(e, actor);
        if (e.mode !== this.mode) throw new AppError('NOT_FOUND', 'Exchange not found in this mode.');
        const [buyer, seller] = await Promise.all([this.repository.privateInput(e, e.buyerId), this.repository.privateInput(e, e.sellerId)]);
        const serviceActions=await listServiceActions(this,actor,e.id);
        return { ...view, harness: harnessContext(e, actor, actor===e.buyerId ? buyer : seller, buyer, seller,this.now()),
          shippingData: await shippingDataView(this,e,actor,this.now()),
          deliveries: await this.deliveries(actor, e.id), research: await this.research.list(actor,e.id),connections:await listConnections(this,actor,e.id),serviceActions:serviceActions.slice(-5),serviceActionHistoryCursor:serviceActions.length>5?serviceActions.at(-5)!.id:null };
      }));
      const inbox = (await this.inbox(actor)).filter(m => !command.exchangeId || m.exchangeId === command.exchangeId).slice(0, 10)
        .map(m => ({ id: m.id, exchangeId: m.exchangeId, kind: m.kind, text: m.payload.text ?? m.payload.reason ?? m.payload.action ?? null }));
      return { mode: this.mode, exchanges, inbox, preferences: (await this.preferences(actor)).slice(0, 30), untrustedCounterpartyData: true,
        scope: 'Up to five recent exchanges and ten messages. Pass exchangeId to inspect a particular exchange.' };
    }
    if (command.action === 'suggest_preference') return this.preference(actor, { key: command.key, value: command.value, provenance: command.provenance }, true);
    if (command.action === 'research') return this.research.request(actor,command.exchangeId,command.research);
    if (command.action === 'service_history') return serviceActionHistory(this,actor,command);
    if (command.action === 'prepare_service_action') return prepareServiceAction(this,actor,context.requestMessageId,command);
    if (command.action === 'prepare_shipping_rates') return prepareShippingRates(this,actor,context.requestMessageId,command);
    if (command.action === 'prepare_shipping_validation') return prepareShippingValidation(this,actor,context.requestMessageId,command);
    const key = command.action === 'ask_owner' ? `agent:${context.requestMessageId}:${digest(command)}` : `agent-action:${context.requestMessageId}`;
    if (command.action === 'draft_request') {
      const e = await this.create(actor, key, command.input);
      return { exchangeId: e.id, status: 'waiting_for_owner_share_approval' };
    }
    await this.repository.transaction(async sql => {
      if (await this.repository.previousCommand(sql, actor, key, command)) return;
      const e = await this.repository.get(command.exchangeId, actor, sql, true);
      exchangeView(e, actor);
      if (e.mode !== this.mode) throw new AppError('NOT_FOUND', 'Exchange not found in this mode.');
      if (command.action === 'prepare_action') {
        if (e.revision !== command.revision) conflict('The exchange changed. Read the current state before preparing an action.');
        if (['message', 'decline', 'quote', 'propose_shipping_data'].includes(command.command.type)) mutable(e, this.now());
        if (command.command.type === 'propose_shipping_data') requireRole(e, actor, 'seller');
        if (command.command.type === 'decline') requireRole(e, actor, 'seller');
        if (command.command.type === 'checkout') requireRole(e, actor, 'buyer');
        const data = await this.repository.privateInput(e, actor, sql);
        const terms = { id: randomUUID(), revision: e.revision + 1, command: command.command, explanation: command.explanation,
          expiresAt: new Date(this.now().getTime() + 24 * 60 * 60_000).toISOString() };
        data.agentAction = { ...terms, digest: digest({ actor, exchangeId: e.id, ...terms }) };
        await this.repository.savePrivate(sql, e, actor, data);
        await this.repository.save(sql, e, this.now());
        await this.repository.event(sql, e, actor, 'agent_action_prepared', { actionId: terms.id, digest: data.agentAction.digest });
        await this.repository.message(sql, e, actor, actor, 'status', { action: 'review_agent_action' });
      } else if (command.action === 'draft_item') {
        mutable(e, this.now());
        requireRole(e, actor, 'seller');
        e.itemDraft = command.item;
        await this.repository.save(sql, e, this.now());
        await this.repository.message(sql, e, actor, actor, 'status', { action: 'approve_item', item: command.item });
      } else await this.repository.message(sql, e, actor, actor, 'question', { text: command.question });
      await this.repository.recordCommand(sql, actor, key, command, e.id);
    });
    return { status: 'waiting_for_owner', exchangeId: command.exchangeId };
  }
}
