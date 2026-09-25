import { z } from 'zod';
import { conflict, packingSchema, type Dropoff, type Packing } from './domain.js';
import { publicLocationFetch } from './public-http.js';

const location = /^https:\/\/local\.fedex\.com\/en-us\/[a-z]{2}\/[a-z0-9-]+\/[a-z0-9-]+$/;
export function supportedDropoffSource(url: string) { return location.test(url); }
const days = ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'] as const;
const time = z.number().int().min(0).max(2400).refine(n => n % 100 < 60 && (n < 2400 || n === 2400));
const day = z.object({ day: z.enum(days), isClosed: z.boolean(), intervals: z.array(z.object({ start: time, end: time })).max(4) });
const text = z.string().trim().min(1).max(300);
const decimal = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).transform(Number);
const profileSchema = z.object({ meta: z.object({ id: z.string() }), c_pagesURL: z.string(), name: text,
  closed: z.literal(false), addressHidden: z.literal(false), c_locatorDropoff: z.literal(true),
  c_isDropOffLocation: z.literal(true), c_dropOffLocation: z.literal(true),
  address: z.object({ line1: text, line2: text.nullish(), line3: text.nullish(), city: text,
    region: z.string().regex(/^[A-Z]{2}$/), postalCode: z.string().regex(/^\d{5}(-\d{4})?$/), countryCode: z.literal('US') }),
  services: z.array(text).max(100), c_additionalServices: z.array(text).max(100),
  c_maxAcceptedPackageWeight: decimal, c_maxAcceptedPackageWeightUnitOfMeasurment: z.literal('LB'),
  c_maxPackageLength: decimal, c_maxPackageWidth: decimal, c_maxPackageHeight: decimal,
  hours: z.object({ normalHours: z.array(day).length(7), holidayHours: z.array(z.unknown()).max(100) }),
});
export interface DropoffRequest { sourceUrl: string; carrierToken: string; serviceToken: string; packing: Packing }
/** Public facts must be fetched by this server from the actual carrier source.
 * Agent text and search snippets are never accepted as capability evidence. */
export function publicFedexDropoff(raw: unknown, entityId: string, request: DropoffRequest, now = new Date()): Dropoff {
  if (!supportedDropoffSource(request.sourceUrl) || request.carrierToken !== 'fedex'
    || request.serviceToken !== 'fedex_ground') conflict('This source does not verify the selected shipping service.');
  const parsed = z.object({ response: z.object({ count: z.literal(1), entities: z.array(z.object({ profile: profileSchema })).length(1) }) }).safeParse(raw);
  if (!parsed.success) conflict('Carrier location details are incomplete or unsupported.');
  const p = parsed.data.response.entities[0]!.profile;
  const packing = packingSchema.parse(request.packing);
  if (p.meta.id !== entityId || p.c_pagesURL !== request.sourceUrl || !p.services.includes('FedEx Ground')
    || !p.c_additionalServices.includes('Ground drop off')) conflict('The carrier location does not confirm this Ground service.');
  if (!packing.canPrint) conflict('This location check supports a printed label. QR returns do not prove outbound label printing.');
  // FedEx's published domestic Ground limits plus any tighter location limits.
  const dimensions = [packing.lengthIn,packing.widthIn,packing.heightIn].sort((a,b)=>b-a);
  const limits = [p.c_maxPackageLength,p.c_maxPackageWidth,p.c_maxPackageHeight].sort((a,b)=>b-a);
  if (packing.weightOz > Math.min(150,p.c_maxAcceptedPackageWeight)*16 || dimensions[0]! > 108
    || dimensions[0]! + 2*dimensions[1]! + 2*dimensions[2]! > 165
    || limits.some((limit,i)=>limit>0 && dimensions[i]!>limit)) conflict('The parcel exceeds this carrier location or service limit.');
  // Zero dimensions are unspecified. Accept them only at the named staffed
  // carrier Ship Center, where the normal Ground service limits apply.
  if (limits.some(n=>n===0) && p.name !== 'FedEx Ship Center') conflict('The location does not publish sufficient package limits.');
  const regular = p.hours.normalHours;
  if (new Set(regular.map(h=>h.day)).size !== 7 || !regular.some(h=>!h.isClosed)
    || regular.some(h=>h.isClosed ? h.intervals.length!==0 : !h.intervals.length || h.intervals.some(v=>v.start>=v.end))
    || p.hours.holidayHours.length) conflict('Opening hours need additional verification before selecting this location.');
  const hhmm = (n:number) => `${String(Math.floor(n/100)).padStart(2,'0')}:${String(n%100).padStart(2,'0')}`;
  const hours = days.map(d=>{const h=regular.find(h=>h.day===d)!;
    return `${d}: ${h.isClosed?'closed':h.intervals.map(v=>`${hhmm(v.start)}–${hhmm(v.end)}`).join(', ')}`;
  }).join('; ') + ' (regular local hours; check for changes before travel)';
  const a=p.address,address=[a.line1,a.line2,a.line3,a.city,a.region,a.postalCode,'US'].filter(Boolean).join(', ');
  return {providerId:entityId,name:p.name,address,hours,checkedAt:now.toISOString(),carrier:'FedEx',service:request.serviceToken,artifact:'pdf',
    mapUrl:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`};
}

export async function verifyPublicDropoff(request: DropoffRequest, fetcher = publicLocationFetch): Promise<Dropoff> {
  if (!supportedDropoffSource(request.sourceUrl) || request.carrierToken !== 'fedex' || request.serviceToken !== 'fedex_ground') {
    conflict('An observed supported official location page is required for this selected service.');
  }
  try {
    const response=await fetcher(request.sourceUrl,'html')(request.sourceUrl,{headers:{Accept:'text/html'}});
    if(response.status!==200) throw new Error();
    const html=await response.text();
    const matches=[...html.matchAll(/Yext\["EntityId"\]\s*=\s*"([A-Za-z0-9_-]{1,64})"/g)];
    if(matches.length!==1) throw new Error();
    const entityId=matches[0]![1]!;
    const url=`https://local.fedex.com/en/search?entityId=${encodeURIComponent(entityId)}`;
    const data=await fetcher(url,'json')(url,{headers:{Accept:'application/json'}});
    if(data.status!==200) throw new Error();
    return publicFedexDropoff(await data.json(),entityId,request);
  } catch { conflict('The official carrier location could not be verified for the selected service, package and printing path.'); }
}
