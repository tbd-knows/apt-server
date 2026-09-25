import { describe, expect, it } from 'vitest';
import { approve, approvalFor, createExchange, digest, draftRequestSchema, exchangeView, offerSettlement, type Offer } from '../src/commerce/domain.js';
import { CommerceService } from '../src/commerce/service.js';
import { USER_A, USER_B } from './fixtures.js';

const now = new Date('2026-09-23T10:00:00Z');
const request = { item: 'White Nike Air Force 1', style: 'Low', size: '10', sizingSystem: 'US men' as const, condition: 'Used in good condition' };
function offered() {
  const e = createExchange(USER_A, USER_B, 'test', request, now);
  e.stage = 'offered'; e.requestShared = true;
  e.offers = [{ version: 1, buyerTotal: 6500, currency: 'USD', expiresAt: '2026-09-23T12:00:00Z',
    taxAmount: 0, feeAmount: 0, item: { description: 'Real shoes', sellerAmount: 5000 }, quote: { originVersion: 1, destinationVersion: 2, carrier: 'FedEx', service: 'Ground', shippingAmount: 1500 } } as Offer];
  return e;
}
describe('commerce authority', () => {
  it('requires explicit sizing and private all-in budget, and rejects authority fields', () => {
    expect(draftRequestSchema.safeParse({ request: { ...request, sizingSystem: undefined }, privateBudget: 7000 }).success).toBe(false);
    expect(draftRequestSchema.safeParse({ request }).success).toBe(false);
    expect(draftRequestSchema.safeParse({ request, privateBudget: 70.5 }).success).toBe(false);
    expect(draftRequestSchema.safeParse({ request, privateBudget: 7000, approved: true }).success).toBe(false);
  });
  it('binds actor, operation and every exact offer field; rejects tampering/replay/expiry', () => {
    const e = offered(); const binding = approvalFor(e, USER_A);
    expect(() => approve(e, USER_B, binding, now)).toThrow('does not match');
    expect(() => approve(e, USER_A, { ...binding, amount: 1 }, now)).toThrow('does not match');
    expect(() => approve(e, USER_A, binding, new Date('2026-09-24'))).toThrow('expired');
    approve(e, USER_A, binding, now);
    expect(() => approve(e, USER_A, binding, now)).toThrow('already');
    e.approvals = []; e.offers[0]!.quote.destinationVersion++;
    expect(() => approve(e, USER_A, binding, now)).toThrow('does not match');
  });
  it('binds the postage payer and reimbursement to both approvals without rewriting old offers', () => {
    const e = offered(), oldOffer = structuredClone(e.offers[0]!);
    const oldBinding = approvalFor(e, USER_B);
    expect(offerSettlement(oldOffer)).toEqual({ postageFunding: 'platform', postageReimbursement: 0, sellerTransferAmount: 5000 });
    e.offers[0]!.postageFunding = 'seller_reimbursed';
    expect(() => approve(e, USER_B, oldBinding, now)).toThrow('does not match');
    for (const actor of [USER_A, USER_B]) {
      const binding = approvalFor(e, actor);
      expect(binding.settlement).toEqual({ postageFunding: 'seller_reimbursed', postageReimbursement: 1500, sellerTransferAmount: 6500 });
      expect(() => approve(e, actor, { ...binding, settlement: { ...binding.settlement, sellerTransferAmount: 5000 } }, now)).toThrow('does not match');
      approve(e, actor, binding, now);
    }
    expect(exchangeView(e, USER_A).settlement?.sellerTransferAmount).toBe(6500);
    expect(oldOffer.postageFunding).toBeUndefined();
    e.offers[0] = oldOffer;
    expect(approvalFor(e, USER_B)).toEqual(oldBinding);
    for (const patch of [{ buyerTotal: 6501 }, { taxAmount: -1 }, { feeAmount: 0.5 }, { postageFunding: 'unexpected' }]) {
      expect(() => offerSettlement({ ...oldOffer, ...patch } as Offer)).toThrow();
    }
  });
  it('does not expose seller drafts or unpublished requests to the buyer/counterparty', () => {
    const e = offered();
    e.itemDraft = { description: 'PRIVATE_CANARY' } as never;
    expect(JSON.stringify(exchangeView(e, USER_A))).not.toContain('PRIVATE_CANARY');
    e.requestShared = false;
    expect(() => exchangeView(e, USER_B)).toThrow('not found');
    expect(() => exchangeView(e, 'foreign')).toThrow('not found');
  });
  it('requires two founders and denies third identities before database access', async () => {
    const s = new CommerceService({} as never, [USER_A, USER_B], 'test');
    await expect(s.list('foreign')).rejects.toThrow('two configured');
    expect(() => new CommerceService({} as never, [USER_A, USER_A], 'test')).toThrow('distinct');
  });
  it('does not expose human or provider authority as agent tool actions', async () => {
    const s = new CommerceService({} as never, [USER_A, USER_B], 'test');
    for (const action of ['approve', 'checkout', 'mark_paid', 'label', 'share_request']) {
      await expect(s.invoke({ userId: USER_A, runId: 'r', requestMessageId: 'm' }, { action })).rejects.toThrow();
    }
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });
});
