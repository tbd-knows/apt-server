import { describe, it, expect } from 'vitest';
import { shippoRefund, shippoTracking } from '../src/commerce/shippo-evidence.js';
import type { ServiceResult } from '../src/commerce/mcp-execution.js';

const now = new Date('2026-09-25T12:00:00Z');
const binding = { transactionId: 'transaction_a', trackingNumber: 'TRACK_A', carrierToken: 'fedex' };
const event = { object_id: 'event_a', object_updated: now.toISOString(), status_date: now.toISOString(), status: 'TRANSIT' };
const track = () => ({ carrier: 'fedex', tracking_number: 'TRACK_A', transaction: 'transaction_a', tracking_status: event,
  address_to: { city: 'PRIVATE_LOCATION_CANARY' }, tracking_history: [], messages: ['PRIVATE_MESSAGE_CANARY'] });
const refund = () => ({ object_id: 'refund_a', object_owner: 'PRIVATE_ACCOUNT_CANARY', test: false, transaction: 'transaction_a', status: 'SUCCESS' });
const refundBinding = { transactionId: 'transaction_a', accountOwner: 'PRIVATE_ACCOUNT_CANARY', mode: 'live' as const };
const receipt = (value: unknown): ServiceResult => ({ state: 'returned', result: { text: [], omittedContentTypes: [],
  structuredContent: { ContentType: 'application/json', StatusCode: 200, RawResponse: {}, Result: value } } });

describe('connected postage reconciliation evidence (synthetic provider receipts)', () => {
  it('requires the purchased transaction, carrier and tracking number together', () => {
    expect(shippoTracking(receipt(track()), binding, now)).toEqual({state:'in_transit',eventId:'event_a',updatedAt:now.toISOString(),occurredAt:now.toISOString()});
    for (const patch of [{carrier:'ups'},{tracking_number:'OTHER'},{transaction:'other'},{transaction:undefined}]) {
      expect(() => shippoTracking(receipt({...track(),...patch}),binding,now)).toThrow('Shipping evidence');
    }
    expect(JSON.stringify(shippoTracking(receipt(track()),binding,now))).not.toContain('PRIVATE_');
  });
  it('does not turn absent or pre-transit tracking into carrier acceptance', () => {
    for (const status of [null,undefined]) expect(shippoTracking(receipt({...track(),tracking_status:status}),binding,now)).toEqual({state:'unknown'});
    for (const [status,state] of [['UNKNOWN','unknown'],['PRE_TRANSIT','label_ready'],['TRANSIT','in_transit'],['DELIVERED','delivered'],['RETURNED','exception'],['FAILURE','exception']]) {
      expect(shippoTracking(receipt({...track(),tracking_status:{...event,status}}),binding,now).state).toBe(state);
    }
    for (const patch of [{status:'INVENTED'},{status_date:undefined},{object_updated:'invalid'},
      {status_date:'2026-09-26T12:00:00Z'},{object_updated:'2026-09-26T12:00:00Z'}]) {
      expect(() => shippoTracking(receipt({...track(),tracking_status:{...event,...patch}}),binding,now)).toThrow('Shipping evidence');
    }
  });
  it('distinguishes pending, completed and rejected postage refunds', () => {
    for (const [status,state] of [['QUEUED','pending'],['PENDING','pending'],['SUCCESS','refunded'],['ERROR','rejected']]) {
      expect(shippoRefund(receipt({...refund(),status}),refundBinding,'refund_a')).toEqual({refundId:'refund_a',state});
    }
    for (const patch of [{object_owner:'other'},{test:true},{transaction:'other'},{object_id:'other'},{status:'APPROVED'}]) {
      expect(() => shippoRefund(receipt({...refund(),...patch}),refundBinding,'refund_a')).toThrow('Shipping evidence');
    }
    expect(JSON.stringify(shippoRefund(receipt(refund()),refundBinding))).not.toContain('PRIVATE_');
  });
  it('refuses failed or contradictory MCP envelopes despite plausible payloads', () => {
    const result = receipt(track());
    expect(() => shippoTracking({...result,state:'uncertain'},binding,now)).toThrow();
    result.result!.text.push(JSON.stringify({ContentType:'application/json',StatusCode:200,RawResponse:{},Result:{...track(),carrier:'ups'}}));
    expect(() => shippoTracking(result,binding,now)).toThrow();
    const denied=receipt(refund());denied.result!.structuredContent!.StatusCode=403;
    expect(() => shippoRefund(denied,refundBinding)).toThrow();
  });
});
