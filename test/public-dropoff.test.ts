import { describe,it,expect,vi } from 'vitest';
import { publicFedexDropoff,supportedDropoffSource,verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { locationFixture,locationUrl,packedBox } from './fixtures/public-dropoff.js';
const request={sourceUrl:locationUrl,carrierToken:'fedex',serviceToken:'fedex_ground',packing:packedBox};
describe('official public drop-off evidence',()=>{
  it('binds actual location identity, exact service, package limits and regular hours',()=>{
    const evidence=publicFedexDropoff(locationFixture(),'FIXTURE',request,new Date('2026-09-25T00:00:00Z'));
    expect(evidence).toMatchObject({providerId:'FIXTURE',artifact:'pdf',carrier:'FedEx',service:'fedex_ground',checkedAt:'2026-09-25T00:00:00.000Z'});
    expect(evidence.hours).toContain('SUNDAY: closed');expect(evidence.hours).toContain('regular local hours');
    expect(evidence.mapUrl).toContain(encodeURIComponent(evidence.address));
  });
  it('rejects search pages, other hosts, credentials, query strings and invented service compatibility',()=>{
    for(const source of [locationUrl+'?token=secret',locationUrl+'#a',locationUrl.replace('local.fedex.com','local.fedex.com.evil.com'),
      'https://user:secret@local.fedex.com/en-us/ny/new-york/fixture','https://local.fedex.com/en/search']) expect(supportedDropoffSource(source)).toBe(false);
    for(const change of [{carrierToken:'ups'},{serviceToken:'fedex_home_delivery'},{packing:{...packedBox,canPrint:false}}]) {
      expect(()=>publicFedexDropoff(locationFixture(),'FIXTURE',{...request,...change})).toThrow();
    }
  });
  it('rejects mismatched, closed, incomplete or ambiguous provider evidence',()=>{
    const mutations:Array<(p:ReturnType<typeof locationFixture>['response']['entities'][number]['profile'])=>void>=[
      p=>{p.meta.id='OTHER';},p=>{p.c_pagesURL=locationUrl+'-other';},p=>{p.closed=true;},p=>{p.addressHidden=true;},
      p=>{p.c_locatorDropoff=false;},p=>{p.services=[];},p=>{p.c_additionalServices=['QR code returns'];},
      p=>{p.hours.normalHours[1]=p.hours.normalHours[0]!;},p=>{p.hours.normalHours[0]!.intervals=[{start:1765,end:1800}];},
      p=>{p.hours.normalHours[0]!.intervals=[{start:1800,end:900}];},p=>{p.hours.holidayHours=[{date:'2026-12-25'}];},
      p=>{p.name='Unspecified parcel counter';},p=>{p.c_maxAcceptedPackageWeight='0';},p=>{p.c_maxPackageLength='4';p.c_maxPackageWidth='4';p.c_maxPackageHeight='4';},
    ];
    for(const mutate of mutations) {const data=locationFixture();mutate(data.response.entities[0]!.profile);expect(()=>publicFedexDropoff(data,'FIXTURE',request)).toThrow();}
    const ambiguous=locationFixture();ambiguous.response.entities.push(ambiguous.response.entities[0]!);
    expect(()=>publicFedexDropoff(ambiguous,'FIXTURE',request)).toThrow();
    for(const packing of [{...packedBox,weightOz:2401},{...packedBox,lengthIn:109},{...packedBox,lengthIn:100,widthIn:30,heightIn:30}]) {
      expect(()=>publicFedexDropoff(locationFixture(),'FIXTURE',{...request,packing})).toThrow();
    }
  });
  it('derives the one public entity lookup without executing scripts or accepting model location facts',async()=>{
    const calls:string[]=[];
    const fetcher:Parameters<typeof verifyPublicDropoff>[1]=(url,format)=>async()=>{
      calls.push(url);return new Response(format==='html' ? '<script>Yext["EntityId"] = "FIXTURE";</script>' : JSON.stringify(locationFixture()));
    };
    expect((await verifyPublicDropoff(request,fetcher)).providerId).toBe('FIXTURE');
    expect(calls).toEqual([locationUrl,'https://local.fedex.com/en/search?entityId=FIXTURE']);
    const unsafe=vi.fn(()=>async()=>new Response('Yext["EntityId"] = "../private?token=SECRET"'));
    await expect(verifyPublicDropoff(request,unsafe)).rejects.toThrow('could not be verified');expect(unsafe).toHaveBeenCalledTimes(1);
    const redirect=vi.fn(()=>async()=>new Response('SECRET_REMOTE_PAGE',{status:302}));
    await expect(verifyPublicDropoff(request,redirect)).rejects.toThrow('could not be verified');expect(redirect).toHaveBeenCalledTimes(1);
  });
});
