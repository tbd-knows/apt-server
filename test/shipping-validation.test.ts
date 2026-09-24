import { describe,it,expect } from 'vitest';
import { requireAddressDescription,requireAddressValidationContract } from '../src/commerce/shipping-validation.js';
import { shippoAddressArguments } from '../src/commerce/shippo-evidence.js';
import type { ServiceActionRow } from '../src/commerce/service-actions.js';
import { serviceActionView } from '../src/commerce/service-actions.js';

const args=shippoAddressArguments({name:'Owner',street1:'PRIVATE_ADDRESS_CANARY',street2:'',city:'Boston',state:'MA',zip:'02110',country:'US',phone:'+16175550101'});
const tool={name:'shippo_read_execute_tool',description:'Claimed free',inputSchema:{type:'object',properties:{name:{type:'string'},arguments:{type:'object'}},required:['name','arguments']}};
const invocation={tool,arguments:{name:'ValidateAddress',arguments:args}};
describe('independent free address validation contract',()=>{
  it('admits only the observed supported wrapper and exact address operation',()=>{
    expect(()=>requireAddressValidationContract('https://mcp.shippo.com/',invocation)).not.toThrow();
    for(const endpoint of ['https://mcp.shippo.com.evil.com/','https://mcp.shippo.com/unknown','https://mcp.vendor.com/']) {
      expect(()=>requireAddressValidationContract(endpoint,invocation)).toThrow('supported free');
    }
    for(const name of ['GetTrack','CreateAddress','CreateTransaction','ValidateAddressByID']) {
      expect(()=>requireAddressValidationContract('https://mcp.shippo.com/',{...invocation,arguments:{...invocation.arguments,name}})).toThrow('supported free');
    }
    expect(()=>requireAddressValidationContract('https://mcp.shippo.com/',{...invocation,arguments:{...invocation.arguments,extra:'anything'}})).toThrow();
    expect(()=>requireAddressValidationContract('https://mcp.shippo.com/',{...invocation,arguments:{name:'ValidateAddress',arguments:{...args,phone:'unapproved'}}})).toThrow();
    for(const inputSchema of [{type:'object',properties:{operation:{type:'string'},input:{type:'object'}},required:['operation','input']},
      {...tool.inputSchema,allOf:[{additionalProperties:true}]}, {...tool.inputSchema,required:['name','arguments','unknown']}]) {
      expect(()=>requireAddressValidationContract('https://mcp.shippo.com/',{...invocation,tool:{...tool,inputSchema}})).toThrow();
    }
  });
  it('requires a stored successful nested operation description and known input fields',()=>{
    const descriptor={name:'ValidateAddress',kind:'read',inputSchema:{type:'object',properties:Object.fromEntries(Object.keys(args).map(key=>[key,{type:'string'}])),required:['country_code','address_line_1']}};
    const row={state:'returned',invocation:{tool:{name:'shippo_describe_tool'}},result:{text:[],structuredContent:descriptor,omittedContentTypes:[]}} as unknown as ServiceActionRow;
    expect(()=>requireAddressDescription(row)).not.toThrow();
    expect(()=>requireAddressDescription({...row,state:'returned_error'})).toThrow();
    for(const change of [{name:'CreateAddress'},{kind:'write'},{inputSchema:{...descriptor.inputSchema,required:['secret']}}]) {
      expect(()=>requireAddressDescription({...row,result:{...row.result!,structuredContent:{...descriptor,...change}}})).toThrow();
    }
  });
  it('omits other-owner input values from every service-action projection',()=>{
    const row={invocation:{...invocation,shippingValidation:{consentId:'c',addressOwnerId:'buyer',addressVersion:1,descriptionActionId:'d'}},
      result:{text:['PRIVATE_ADDRESS_CANARY'],omittedContentTypes:[],structuredContent:{addressValidation:'valid',echo:'PRIVATE_ADDRESS_CANARY'}}} as unknown as ServiceActionRow;
    expect(JSON.stringify(serviceActionView(row))).not.toContain('PRIVATE_ADDRESS_CANARY');
    expect(serviceActionView(row).purpose).toBe('free_address_validation');
  });
});
