import { describe,it,expect } from 'vitest';
import { publicUpsDropoff,supportedUpsDropoffSource } from '../src/commerce/public-ups-dropoff.js';
import { verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { upsLocationFixture,upsLocationHtml,upsLocationUrl } from './fixtures/ups-dropoff.js';
import { packedBox } from './fixtures/public-dropoff.js';
const request={sourceUrl:upsLocationUrl,carrierToken:'ups',serviceToken:'ups_ground',packing:packedBox,itemValue:5000};
describe('official UPS Store evidence',()=>{
  it('binds location identity, Ground acceptance, package, value and holiday hours',()=>{
    const fact=publicUpsDropoff(upsLocationHtml(),request,new Date('2026-09-25T00:00:00Z'));
    expect(fact).toMatchObject({providerId:'ups-store-1234',carrier:'UPS',service:'ups_ground',artifact:'pdf'});
    expect(fact.hours).toContain('2026-12-25: closed');expect(fact.hours).toContain('SUNDAY: closed');
    expect(fact.restrictions).toContain('$1,000');expect(fact.mapUrl).toContain(encodeURIComponent(fact.address));
  });
  it('rejects foreign/search/credential URLs and unsupported service or printing assumptions',()=>{
    for(const url of [upsLocationUrl+'?a=b',upsLocationUrl+'#x',upsLocationUrl.replace('locations.','evil.'),
      'https://locations.theupsstore.com/ny/new-york','https://user@locations.theupsstore.com/ny/new-york/100-fixture-ave']) {
      expect(supportedUpsDropoffSource(url)).toBe(false);
    }
    for(const change of [{carrierToken:'fedex'},{serviceToken:'ups_saver'},{packing:{...packedBox,canPrint:false}},
      {itemValue:undefined},{itemValue:100000},{itemValue:-1},{itemValue:99.9},{packing:{...packedBox,lengthIn:60,widthIn:40,heightIn:40}}]) {
      expect(()=>publicUpsDropoff(upsLocationHtml(),{...request,...change})).toThrow();
    }
  });
  it('rejects closed, mismatched, ambiguous and incomplete locations without executing page scripts',()=>{
    const mutations:Array<(p:ReturnType<typeof upsLocationFixture>['document'])=>void>=[
      p=>{p.id='9999';},p=>{p.slug='ny/elsewhere/store';},p=>{p.c_dataFeedStoreStatus='Closed';},
      p=>{p.c_cHomePageLocalAlertMessage='Temporarily closed';},p=>{p.c_productsAndServices=[];},
      p=>{p.c_locationFAQsGroup1.fAQSection=[];},p=>{p.hours.monday.openIntervals=[{start:'18:00',end:'09:00'}];},
      p=>{p.hours.monday.openIntervals=[{start:'09:65',end:'18:00'}];},
      p=>{p.hours.holidayHours.push({...p.hours.holidayHours[0]!});},
    ];
    for(const mutate of mutations) {const data=upsLocationFixture();mutate(data.document);expect(()=>publicUpsDropoff(upsLocationHtml(data),request)).toThrow();}
    expect(()=>publicUpsDropoff(upsLocationHtml()+upsLocationHtml(),request)).toThrow('ambiguous');
    expect(()=>publicUpsDropoff('<script>throw new Error("not executed")</script>',request)).toThrow('missing');
    const mismatched=upsLocationFixture();mismatched.path+='-other';expect(()=>publicUpsDropoff(upsLocationHtml(mismatched),request)).toThrow();
  });
  it('uses only the observed public page, with no credentials or address disclosure',async()=>{
    const requests:string[]=[];
    const fetcher:Parameters<typeof verifyPublicDropoff>[1]=(url,format)=>async(_input,init)=>{
      requests.push(url);expect(format).toBe('html');expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has('authorization')).toBe(false);return new Response(upsLocationHtml());
    };
    expect((await verifyPublicDropoff(request,fetcher)).carrier).toBe('UPS');expect(requests).toEqual([upsLocationUrl]);
    await expect(verifyPublicDropoff({...request,sourceUrl:'https://untrusted.invalid/location'},fetcher)).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
});
