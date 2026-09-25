import { z } from 'zod';
import { conflict,packingSchema,type Dropoff } from './domain.js';
import type { DropoffRequest } from './public-dropoff.js';

const source=/^https:\/\/locations\.theupsstore\.com\/[a-z]{2}\/[a-z0-9-]+\/[a-z0-9-]+\/?$/;
export const supportedUpsDropoffSource=(url:string)=>source.test(url);
const days=['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const;
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const intervals=z.array(z.object({start:clock,end:clock})).max(4);
const hours=z.object({isClosed:z.boolean().optional(),openIntervals:intervals.optional()});
const text=z.string().trim().min(1).max(300);
const profile=z.object({id:z.string().regex(/^\d{1,8}$/),c_dataFeedStoreID:z.string(),c_dataFeedStoreStatus:z.literal('Open'),
  slug:z.string(),pageType:z.literal('location'),name:z.literal('The UPS Store'),
  c_cHomePageLocalAlertMessage:z.string().max(2000).optional(),
  address:z.object({line1:text,line2:text.optional(),city:text,region:z.string().regex(/^[A-Z]{2}$/),
    postalCode:z.string().regex(/^\d{5}(-\d{4})?$/),countryCode:z.literal('US')}),
  c_productsAndServices:z.array(z.object({title:text,productServices:z.array(text).max(100)})).max(30),
  c_locationFAQsGroup1:z.object({fAQGroupTitle:z.literal('Shipping'),fAQSection:z.array(z.object({question:z.string().max(2000),
    answer:z.object({html:z.string().max(20000)})})).max(30)}),
  hours:z.object({monday:hours,tuesday:hours,wednesday:hours,thursday:hours,friday:hours,saturday:hours,sunday:hours,
    holidayHours:z.array(hours.extend({date:z.iso.date(),isRegularHours:z.boolean().optional()})).max(100).optional()}),
  c_dataFeedUPSGroundPickupTimes:z.object(Object.fromEntries(days.map(day=>[day,clock.optional()]))),
});
/** The actual location page serializes its public profile as JSON. Parse that
 * one data literal; never evaluate page scripts or accept model-authored facts.
 * UPS size limits: ups.com/us/en/support/shipping-support/shipping-dimensions-weight/avoid-additional-shipping-fees
 * This adapter intentionally requires a prepaid printed Ground label. */
export function publicUpsDropoff(html:string,request:DropoffRequest,now=new Date()):Dropoff {
  if(!supportedUpsDropoffSource(request.sourceUrl) || request.carrierToken!=='ups' || request.serviceToken!=='ups_ground') {
    conflict('This official location does not verify the selected UPS service.');
  }
  const matches=[...html.matchAll(/pageProps:\s*JSON\.parse\(decodeURIComponent\("([^"\r\n]+)"\)\)/g)];
  if(matches.length!==1) conflict('The UPS location profile is missing or ambiguous.');
  let raw:unknown;
  try {raw=JSON.parse(decodeURIComponent(matches[0]![1]!));} catch {conflict('The UPS location profile is unsupported.');}
  const parsed=z.object({path:z.string(),document:profile}).safeParse(raw);
  if(!parsed.success) conflict('The UPS location details are incomplete or unsupported.');
  const p=parsed.data.document,path=new URL(request.sourceUrl).pathname.replace(/^\/|\/$/g,'');
  if(p.slug!==path || parsed.data.path!==path || p.id!==p.c_dataFeedStoreID
    || /closed|unavailable|relocat|temporar/i.test(p.c_cHomePageLocalAlertMessage ?? '')
    || !p.c_productsAndServices.some(group=>group.title==='Shipping Services' && group.productServices.includes('UPS Ground'))) {
    conflict('This UPS location does not currently confirm Ground shipping.');
  }
  // This is a narrow supported publication shape, not natural-language policy
  // inference: capability changes fail closed and require adapter review.
  const answers=p.c_locationFAQsGroup1.fAQSection.map(q=>q.answer.html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' '));
  if(!answers.some(a=>/locations accept UPS drop offs/.test(a) && /Ground/.test(a))) {
    conflict('This UPS location does not confirm prepaid Ground drop-off.');
  }
  const packing=packingSchema.parse(request.packing);
  if(!packing.canPrint) conflict('A UPS PDF label must be printed before this drop-off. A printing service listing does not establish a free printing path.');
  if(!Number.isSafeInteger(request.itemValue) || request.itemValue!<0 || request.itemValue!>=100_000) {
    conflict('This UPS Store path supports items valued below $1,000. Higher-value shipments need a separately verified handoff.');
  }
  const dimensions=[packing.lengthIn,packing.widthIn,packing.heightIn].sort((a,b)=>b-a);
  if(packing.weightOz>150*16 || dimensions[0]!>108 || dimensions[0]!+2*dimensions[1]!+2*dimensions[2]!>165) {
    conflict('The package exceeds UPS Ground limits.');
  }
  const format=(h:z.infer<typeof hours>)=>{
    if(h.isClosed===true) {
      if(h.openIntervals?.length) conflict('UPS location hours are inconsistent.');
      return 'closed';
    }
    if(!h.openIntervals?.length || h.openIntervals.some((v,i)=>v.start>=v.end || i>0 && v.start<h.openIntervals![i-1]!.end)) {
      conflict('UPS location hours need additional verification.');
    }
    return h.openIntervals.map(v=>`${v.start}–${v.end}`).join(', ');
  };
  const regular=days.map(day=>`${day.toUpperCase()}: ${format(p.hours[day])}`);
  if(days.every(day=>p.hours[day].isClosed) || !days.some(day=>p.c_dataFeedUPSGroundPickupTimes[day])) {
    conflict('The UPS location has no published open hours or Ground pickup.');
  }
  const holidayDates=new Set<string>();
  for(const holiday of p.hours.holidayHours ?? []) {
    if(holidayDates.has(holiday.date)) conflict('UPS holiday hours are ambiguous.');
    holidayDates.add(holiday.date);
    const value=holiday.isRegularHours===true ? 'regular hours' : format(holiday);
    if(holiday.isRegularHours && (holiday.isClosed || holiday.openIntervals?.length)) conflict('UPS holiday hours are inconsistent.');
    if(holiday.date>=new Date(now.getTime()-86400000).toISOString().slice(0,10)) regular.push(`${holiday.date}: ${value}`);
  }
  const a=p.address,address=[a.line1,a.line2,a.city,a.region,a.postalCode,'US'].filter(Boolean).join(', ');
  return {providerId:`ups-store-${p.id}`,name:`The UPS Store #${p.id}`,address,
    hours:regular.join('; ')+' (local hours; confirm changes before travel)',checkedAt:now.toISOString(),carrier:'UPS',service:'ups_ground',artifact:'pdf',
    restrictions:'Bring a sealed package and a printed, prepaid UPS label. This path excludes items valued at $1,000 or more and restricted goods. Additional packing or printing can cost extra.',
    mapUrl:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`};
}
