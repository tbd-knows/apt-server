/** Synthetic public carrier shape; no copied carrier reviews or owner data. */
export const locationUrl='https://local.fedex.com/en-us/ny/new-york/fixture';
export const packedBox={weightOz:32,lengthIn:12,widthIn:8,heightIn:6,packed:true as const,canPrint:true};
export function locationFixture() {
  return {response:{count:1,entities:[{profile:{meta:{id:'FIXTURE'},c_pagesURL:locationUrl,name:'FedEx Ship Center',
    closed:false,addressHidden:false,c_locatorDropoff:true,c_isDropOffLocation:true,c_dropOffLocation:true,
    address:{line1:'100 Public Street',line2:null,line3:null,city:'New York',region:'NY',postalCode:'10001',countryCode:'US'},
    services:['FedEx Ground'],c_additionalServices:['Ground drop off','QR code returns'],
    c_maxAcceptedPackageWeight:'150',c_maxAcceptedPackageWeightUnitOfMeasurment:'LB',
    c_maxPackageLength:'0',c_maxPackageWidth:'0',c_maxPackageHeight:'0',
    hours:{normalHours:['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY'].map(day=>
      ({day,isClosed:day==='SUNDAY',intervals:day==='SUNDAY'?[]:[{start:900,end:1700}]})),holidayHours:[] as unknown[]},
  }}]}};
}
