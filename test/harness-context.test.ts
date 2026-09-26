import { it,expect } from 'vitest';
import { emptyPrivateInput } from '../src/commerce/repository.js';
import { harnessContext } from '../src/commerce/harness.js';
import { createExchange,type Offer } from '../src/commerce/domain.js';

it('does not ask for a printer when a current verified printing-code offer already covers it',()=>{
  const now=new Date('2026-09-25T00:00:00Z'),a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  const e=createExchange(a,b,'test',{item:'Shoes',style:'White',size:'10',sizingSystem:'US men',condition:'Good'},now);
  e.requestShared=true;e.stage='offered';
  e.item={itemId:a,description:'Shoes',size:'10',sizingSystem:'US men',condition:'Good',defects:'',photoIds:[a],sellerAmount:1000};
  const buyer={...emptyPrivateInput(),addressVersion:1},seller={...emptyPrivateInput(),addressVersion:2,packingVersion:3,
    packing:{lengthIn:12,widthIn:8,heightIn:6,weightOz:32,packed:true as const,canPrint:false}};
  const missing=()=>harnessContext(e,b,seller,buyer,seller,now).missing;
  expect(missing()).toContain('supported_no_printer_fulfillment');
  const quote={artifact:'label_qr',expiresAt:'2026-09-25T00:15:00Z',originVersion:2,destinationVersion:1,packingVersion:3,
    carrier:'USPS',service:'Ground Advantage',dropoff:{artifact:'label_qr',carrier:'USPS',service:'Ground Advantage'}};
  e.offers=[{quote} as Offer];
  expect(missing()).not.toContain('supported_no_printer_fulfillment');
  for(const change of [{artifact:'pdf'},{expiresAt:'2026-09-24T23:00:00Z'},{packingVersion:4},{originVersion:3},
    {destinationVersion:2},{dropoff:{...quote.dropoff,carrier:'UPS'}},{dropoff:{...quote.dropoff,artifact:'pdf'}}]) {
    e.offers=[{quote:{...quote,...change}} as Offer];
    expect(missing()).toContain('supported_no_printer_fulfillment');
  }
});
