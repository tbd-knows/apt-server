import { describe,it,expect } from 'vitest';
import { connectedOfferSchema,connectedOfferExpiry } from '../src/commerce/connected-offer.js';
const now=Date.parse('2026-09-25T00:00:00Z');
const at=(minutes:number)=>new Date(now+minutes*60_000).toISOString();
describe('connected exact-offer boundary',()=>{
  it('caps the offer under the original provider deadline and leaves time for Stripe and fulfillment',()=>{
    expect(connectedOfferExpiry(at(1440),at(1440),now)).toBe(at(120));
    expect(connectedOfferExpiry(at(90),at(1440),now)).toBe(at(89));
    expect(connectedOfferExpiry(at(1440),at(75),now)).toBe(at(75));
    for(const deadline of [at(-1),at(40),at(41),'invalid']) expect(()=>connectedOfferExpiry(deadline,at(1440),now)).toThrow();
    expect(()=>connectedOfferExpiry(at(1440),at(40),now)).toThrow();
  });
  it('accepts evidence identity only, never invented money, account, source or approval',()=>{
    const id='11111111-1111-4111-8111-111111111111';
    const input={action:'prepare_connected_offer',exchangeId:id,revision:1,dropoffId:id};
    expect(connectedOfferSchema.safeParse(input).success).toBe(true);
    for(const extra of [{offer:{}},{amount:1},{shippingAmount:1},{taxAmount:0},{accountOwner:'other'},{sourceUrl:'https://example.com'},{approved:true}]) {
      expect(connectedOfferSchema.safeParse({...input,...extra}).success).toBe(false);
    }
  });
});
