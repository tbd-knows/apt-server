import { z } from 'zod';
import { conflict, packingSchema, type Dropoff } from './domain.js';
import type { DropoffRequest } from './public-dropoff.js';

const source = /^https:\/\/tools\.usps\.com\/locations\/details\/([1-9]\d{0,11})$/;
export const supportedUspsDropoffSource = (url: string) => source.test(url);
const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:00$/);
const text = z.string().trim().min(1).max(300);
const hours = z.object({ name: z.string(), starting: z.null(), ending: z.null(), hours: z.array(z.object({
  day: z.enum(days), times: z.array(z.object({ open: clock, close: clock })).max(4),
})).length(7) });
const profile = z.object({
  locationID: z.string(), locationName: text, locationType: z.literal('PO'),
  address1: text, address2: text.nullish(), city: text, state: z.string().regex(/^[A-Z]{2}$/),
  zip5: z.string().regex(/^\d{5}$/), zip4: z.string().regex(/^\d{4}$/).nullish(),
  closedFacility: z.literal(false), emergencySuspended: z.literal(false), suspended: z.literal(false),
  showNotice: z.null(), specialMessage: z.null(), error: z.null(),
  services: z.array(text).max(150), serviceHours: z.array(z.unknown()).max(100),
});

/** Read only the location's own serialized public record. Nearby facilities,
 * kiosk hours and general Label Broker marketing cannot establish this counter.
 * JSON.parse never evaluates the surrounding publisher JavaScript. */
export function publicUspsDropoff(html: string, request: DropoffRequest, now = new Date()): Dropoff {
  const match = source.exec(request.sourceUrl);
  if (!match || request.carrierToken !== 'usps' || request.serviceToken !== 'usps_ground_advantage') {
    conflict('This official location does not verify the selected USPS service.');
  }
  const matches = [...html.matchAll(/\bvar dat = (\{[^\r\n]+\});\s*\n/g)];
  if (matches.length !== 1) conflict('USPS location data is missing or ambiguous.');
  let raw: unknown;
  try { raw = JSON.parse(matches[0]![1]!); } catch { conflict('USPS location data is unsupported.'); }
  const parsed = z.object({ poDetail: z.array(profile).length(1) }).safeParse(raw);
  if (!parsed.success) conflict('USPS location details are incomplete or report a service disruption.');
  const p = parsed.data.poDetail[0]!;
  if (p.locationID !== match[1] || !p.services.includes('CARRIER')) conflict('USPS location identity or mailing service is not confirmed.');
  const packing = packingSchema.parse(request.packing);
  if (!packing.canPrint && !p.services.includes('LBRORETAIL')) {
    conflict('This location does not confirm Label Broker printing at the staffed retail counter.');
  }
  const dimensions = [packing.lengthIn, packing.widthIn, packing.heightIn].sort((a,b) => b-a);
  if (packing.weightOz > 70*16 || dimensions[0]! + 2*dimensions[1]! + 2*dimensions[2]! > 130) {
    conflict('The package exceeds USPS Ground Advantage limits.');
  }
  const business = p.serviceHours.filter(value => !!value && typeof value === 'object' && (value as { name?: unknown }).name === 'BUSINESS');
  const checked = hours.safeParse(business[0]);
  if (business.length !== 1 || !checked.success) conflict('USPS retail hours need additional verification.');
  const regular = checked.data.hours;
  if (new Set(regular.map(h => h.day)).size !== 7 || !regular.some(h => h.times.length)
    || regular.some(h => h.times.some((t,i) => t.open >= t.close || i > 0 && t.open < h.times[i-1]!.close))) {
    conflict('USPS retail hours are inconsistent.');
  }
  const address = [p.address1, p.address2, p.city, p.state, p.zip5 + (p.zip4 ? `-${p.zip4}` : ''), 'US'].filter(Boolean).join(', ');
  return { providerId: `usps-${p.locationID}`, name: `USPS ${p.locationName}`, address,
    hours: days.map(day => { const h = regular.find(h => h.day === day)!;
      return `${day}: ${h.times.length ? h.times.map(t => `${t.open.slice(0,5)}–${t.close.slice(0,5)}`).join(', ') : 'closed'}`;
    }).join('; ') + ' (regular local retail-counter hours; holiday closures and changes may apply)',
    carrier: 'USPS', service: request.serviceToken, artifact: packing.canPrint ? 'pdf' : 'label_qr', checkedAt: now.toISOString(),
    restrictions: packing.canPrint
      ? 'Bring a sealed package with the purchased, prepaid USPS label attached. Use the staffed retail counter; confirm hours before travel.'
      : 'Bring a sealed package and the purchased shipment’s provider-issued USPS Label Broker QR code to the staffed retail counter. A tracking barcode or label PDF is not a printing code. Confirm hours before travel.',
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}` };
}
