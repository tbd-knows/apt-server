import { describe, expect, it } from 'vitest';
import { publicUspsDropoff, supportedUspsDropoffSource } from '../src/commerce/public-usps-dropoff.js';
import { verifyPublicDropoff } from '../src/commerce/public-dropoff.js';
import { uspsLocationFixture, uspsLocationHtml, uspsLocationUrl } from './fixtures/usps-dropoff.js';

const request = { sourceUrl: uspsLocationUrl, carrierToken: 'usps', serviceToken: 'usps_ground_advantage',
  packing: {weightOz:32,lengthIn:12,widthIn:8,heightIn:6,packed:true as const,canPrint:false} };
describe('official USPS retail drop-off', () => {
  it('requires actual retail Label Broker evidence for a no-printer parcel', async () => {
    const result = publicUspsDropoff(uspsLocationHtml(), request);
    expect(result).toMatchObject({providerId:'usps-1234567',carrier:'USPS',artifact:'label_qr'});
    expect(result.hours).toContain('SU: closed');
    expect(result.restrictions).toContain('provider-issued');
    const urls: string[] = [];
    const verified = await verifyPublicDropoff(request, url => async () => { urls.push(url); return new Response(uspsLocationHtml()); });
    expect(verified.artifact).toBe('label_qr'); expect(urls).toEqual([uspsLocationUrl]);
    const data = uspsLocationFixture(); data.poDetail[0]!.services = ['CARRIER', 'LBROSSK'];
    expect(() => publicUspsDropoff(uspsLocationHtml(data), request)).toThrow('staffed retail');
    expect(publicUspsDropoff(uspsLocationHtml(data), {...request,packing:{...request.packing,canPrint:true}}).artifact).toBe('pdf');
  });
  it('rejects a nearby facility, suspended service and altered URL/service bindings', () => {
    for (const change of [{locationID:'7654321'}, {locationType:'APC'}, {closedFacility:true}, {suspended:true},
      {emergencySuspended:true}, {specialMessage:'Temporarily closed'}, {services:['LBRORETAIL']}]) {
      const data=uspsLocationFixture();Object.assign(data.poDetail[0]!,change);
      expect(() => publicUspsDropoff(uspsLocationHtml(data), request)).toThrow();
    }
    expect(() => publicUspsDropoff(uspsLocationHtml({nearbyPO:uspsLocationFixture().poDetail}),request)).toThrow();
    for(const url of [uspsLocationUrl+'?token=x',uspsLocationUrl+'/',uspsLocationUrl.replace('tools.usps.com','tools.usps.com.evil.com')]) {
      expect(supportedUspsDropoffSource(url)).toBe(false);
    }
    expect(() => publicUspsDropoff(uspsLocationHtml(),{...request,serviceToken:'ups_ground'})).toThrow();
  });
  it('rejects ambiguous data, kiosk-only hours, temporary schedules and excessive size', () => {
    expect(() => publicUspsDropoff(uspsLocationHtml()+uspsLocationHtml(),request)).toThrow('ambiguous');
    const data=uspsLocationFixture();data.poDetail[0]!.serviceHours[0]!.name='LOBBY';
    expect(() => publicUspsDropoff(uspsLocationHtml(data),request)).toThrow('retail hours');
    const duplicate=uspsLocationFixture();duplicate.poDetail[0]!.serviceHours[0]!.hours[6]!.day='MO';
    expect(() => publicUspsDropoff(uspsLocationHtml(duplicate),request)).toThrow('inconsistent');
    expect(() => publicUspsDropoff(uspsLocationHtml(),{...request,packing:{...request.packing,lengthIn:60,widthIn:30,heightIn:30}})).toThrow('limits');
    expect(() => publicUspsDropoff('<script>var dat = doSomething();\n</script>',request)).toThrow();
  });
});
