import { z } from 'zod';
import { AppError } from '../errors.js';
import { conflict, type Dropoff, type Packing } from './domain.js';
import type { ProviderConfig } from './providers.js';

const hoursSchema = z.object({ dayofweek: z.string(), operationalHoursType: z.string(),
  operationalHours: z.array(z.object({ begins: z.string(), ends: z.string() })).optional(),
  exceptionalHoursType: z.string().optional(),
});
const locationSchema = z.object({
  locationId: z.string(), locationType: z.string(), locationAttributeTypes: z.array(z.string()),
  contactAndAddress: z.object({ displayName: z.string().optional(), address: z.object({
    streetLines: z.array(z.string()).min(1), city: z.string(), stateOrProvinceCode: z.string().optional(), postalCode: z.string(), countryCode: z.literal('US'),
  }) }), storeHours: z.array(hoursSchema).min(1),
  carrierDetailList: z.array(z.object({ serviceType: z.string(), carrierCodeType: z.string(), countryRelationshipType: z.string() })),
});

export function compatibleDropoff(raw: unknown, service: string, packing: Packing, now = new Date()): Dropoff {
  const response = z.object({ output: z.object({ locationDetailList: z.array(z.unknown()) }) }).parse(raw);
  // Conservative shoe-parcel path. Never infer drop-box capacity or QR support.
  if (packing.weightOz > 55 * 16 || packing.lengthIn > 48 || packing.widthIn > 25 || packing.heightIn > 25 || !packing.canPrint) {
    conflict('The supported staffed PDF drop-off path requires a printer and a parcel within 55 lb / 48 × 25 × 25 inches.');
  }
  for (const rawLocation of response.output.locationDetailList) {
    const parsed = locationSchema.safeParse(rawLocation);
    if (!parsed.success) continue;
    const location = parsed.data;
    if (!['FEDEX_OFFICE', 'FEDEX_ONSITE', 'FEDEX_STAFFED', 'FEDEX_SHIPSITE'].includes(location.locationType)
      || !location.locationAttributeTypes.includes('GROUND_DROPOFFS')
      || !location.carrierDetailList.some(c => c.carrierCodeType === 'FDXG' && c.serviceType === service && c.countryRelationshipType === 'DOMESTIC')) continue;
    const a = location.contactAndAddress.address;
    const address = [...a.streetLines, a.city, a.stateOrProvinceCode ?? '', a.postalCode, 'US'].filter(Boolean).join(', ');
    const hours = location.storeHours.map(h => `${h.dayofweek}: ${h.operationalHoursType === 'OPEN_BY_HOURS'
      ? (h.operationalHours ?? []).map(t => `${t.begins}–${t.ends}`).join(', ') || 'hours unavailable'
      : h.operationalHoursType.replaceAll('_', ' ').toLowerCase()}${h.exceptionalHoursType ? '; exceptions apply—check before leaving' : ''}`).join('; ');
    return { providerId: location.locationId, name: location.contactAndAddress.displayName ?? 'FedEx drop-off', address, hours,
      mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`,
      checkedAt: now.toISOString(), carrier: 'FedEx', service, artifact: 'pdf' };
  }
  conflict('No verified compatible staffed FedEx drop-off was returned. Verify a supported location before accepting an offer.');
}

export class FedExLocations {
  constructor(private readonly config: ProviderConfig, private readonly fetcher: typeof fetch = fetch) {}
  async find(postcode: string, packing: Packing): Promise<Dropoff> {
    if (!this.config.fedexKey || !this.config.fedexSecret) throw new AppError('PROVIDER_NOT_READY', 'FedEx Locations credentials are required to verify a compatible drop-off.');
    if (this.config.carrier !== 'FedEx' || this.config.service !== 'FEDEX_GROUND') conflict('This pilot location adapter supports FedEx Ground with a printed PDF.');
    const base = this.config.mode === 'live' ? 'https://apis.fedex.com' : 'https://apis-sandbox.fedex.com';
    const auth = await this.fetcher(`${base}/oauth/token`, { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.fedexKey, client_secret: this.config.fedexSecret }) });
    if (!auth.ok) throw new AppError('PROVIDER_NOT_READY', 'FedEx authentication failed.');
    const token = z.object({ access_token: z.string() }).parse(await auth.json());
    const result = await this.fetcher(`${base}/location/v1/locations`, { method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', 'X-locale': 'en_US' },
      body: JSON.stringify({ locationSearchCriterion: 'ADDRESS', location: { address: { postalCode: postcode, countryCode: 'US' } },
        locationsSummaryRequestControlParameters: { distance: { units: 'MI', value: 25 }, maxResults: 20 },
        locationTypes: ['FEDEX_OFFICE', 'FEDEX_ONSITE', 'FEDEX_SHIPSITE'],
        locationCapabilities: [{ serviceType: 'FEDEX_GROUND', carrierCode: 'FDXG', transferOfPossessionType: 'DROPOFF' }],
        carrierCodes: ['FDXG'], dropOffServiceType: 'GROUND', includeHoliday: true,
        packageAttributes: [{ weight: { units: 'LB', value: packing.weightOz / 16 }, dimensions: {
          length: Math.ceil(packing.lengthIn), width: Math.ceil(packing.widthIn), height: Math.ceil(packing.heightIn), units: 'IN' } }],
        sort: { criteria: 'DISTANCE', order: 'ASCENDING' }, sameCountry: true,
      }) });
    if (!result.ok) throw new AppError('PROVIDER_NOT_READY', 'FedEx location lookup failed.');
    return compatibleDropoff(await result.json(), this.config.service, packing);
  }
}
