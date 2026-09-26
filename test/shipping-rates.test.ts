import { describe,it,expect } from 'vitest';
import { shippingRatesSchema,requireShippingRatesContract,shippingRatesResultView } from '../src/commerce/shipping-rates.js';
import { serviceActionView,type ServiceActionRow } from '../src/commerce/service-actions.js';
import type { ServiceInvocation } from '../src/commerce/mcp-execution.js';

const invocation:ServiceInvocation={tool:{name:'shippo_write_execute_tool',description:'Write',inputSchema:{type:'object',
  properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments']}},
  arguments:{name:'CreateShipment',arguments:{address_from:'PRIVATE_ADDRESS_CANARY'}},shippingRates:{consentId:'consent',descriptionActionId:'description',operationId:'operation'}};
describe('approved rate boundary',()=>{
  it('does not admit purchase, tracking, foreign hosts or substituted wrapper schemas',()=>{
    expect(()=>requireShippingRatesContract('https://mcp.shippo.com/',invocation)).not.toThrow();
    for(const operation of ['CreateTransaction','GetTrack','CreateAddress','RefundTransaction']) {
      expect(()=>requireShippingRatesContract('https://mcp.shippo.com/',{...invocation,arguments:{...invocation.arguments,name:operation}})).toThrow();
    }
    expect(()=>requireShippingRatesContract('https://mcp.shippo.com.attacker.example/',invocation)).toThrow();
    expect(()=>requireShippingRatesContract('https://mcp.shippo.com/',{...invocation,tool:{...invocation.tool,name:'shippo_read_execute_tool'}})).toThrow();
    expect(()=>requireShippingRatesContract('https://mcp.shippo.com/',{tool:invocation.tool,arguments:invocation.arguments})).toThrow();
    expect(()=>requireShippingRatesContract('https://mcp.shippo.com/',{...invocation,tool:{...invocation.tool,inputSchema:{type:'object',properties:{any:{type:'object'}}}}})).toThrow();
  });
  it('keeps private inputs/account identity/raw provider replies outside action projections',()=>{
    const row={invocation,result:{text:['PRIVATE_RAW_CANARY'],omittedContentTypes:['resource_link'],structuredContent:{
      shippingRates:{providerMode:'live',accountOwner:'PRIVATE_ACCOUNT_CANARY',shipment:{state:'pending',shipmentId:'ship_1',address:'PRIVATE_ECHO_CANARY'}}}}} as unknown as ServiceActionRow;
    const projected=serviceActionView(row);
    expect(projected.purpose).toBe('free_shipping_rates');
    expect(JSON.stringify(projected)).not.toContain('CANARY');
    expect(projected.result?.structuredContent).toEqual({shippingRates:{providerMode:'live',shipment:{state:'pending',shipmentId:'ship_1'}}});
    for(const shippingRates of [{providerMode:'test',accountOwner:'owner',shipment:{state:'pending',shipmentId:'id'}},
      {providerMode:'live',accountOwner:'owner',shipment:{state:'purchased',shipmentId:'id'}},
      {providerMode:'live',accountOwner:'owner',shipment:{state:'rated',shipmentId:'id',rates:[]}}]) {
      expect(shippingRatesResultView({text:[],omittedContentTypes:[],structuredContent:{shippingRates}})).toBeNull();
    }
  });
  it('does not accept model-supplied addresses, rate prices, account IDs or provider state',()=>{
    const uuid='11111111-1111-4111-8111-111111111111';
    const input={action:'prepare_shipping_rates',exchangeId:uuid,revision:1,connectionId:uuid,consentId:uuid,descriptionActionId:uuid};
    expect(shippingRatesSchema.safeParse(input).success).toBe(true);
    for(const extra of [{arguments:{}},{rateId:'invented'},{accountOwner:'invented'},{mode:'test'},{amount:1},{shipmentId:'invented'}]) {
      expect(shippingRatesSchema.safeParse({...input,...extra}).success).toBe(false);
    }
  });
});
