/** Synthetic data in the observed official page format. */
export const upsLocationUrl='https://locations.theupsstore.com/ny/new-york/100-fixture-ave';
export function upsLocationFixture() {
  const path='ny/new-york/100-fixture-ave';
  return {path,document:{id:'1234',c_dataFeedStoreID:'1234',c_dataFeedStoreStatus:'Open',slug:path,pageType:'location',name:'The UPS Store',
    c_cHomePageLocalAlertMessage:'Open for business',
    address:{line1:'100 Fixture Ave',city:'New York',region:'NY',postalCode:'10001',countryCode:'US'},
    c_productsAndServices:[{title:'Shipping Services',productServices:['UPS Ground']}],
    c_locationFAQsGroup1:{fAQGroupTitle:'Shipping',fAQSection:[{question:'Which shipments are supported?',
      answer:{html:'<p>Our locations accept UPS drop offs, including Ground packages.</p>'}}]},
    hours:{monday:{openIntervals:[{start:'09:00',end:'17:00'}]},tuesday:{openIntervals:[{start:'09:00',end:'17:00'}]},
      wednesday:{openIntervals:[{start:'09:00',end:'17:00'}]},thursday:{openIntervals:[{start:'09:00',end:'17:00'}]},
      friday:{openIntervals:[{start:'09:00',end:'17:00'}]},saturday:{openIntervals:[{start:'10:00',end:'16:00'}]},sunday:{isClosed:true},
      holidayHours:[{date:'2026-12-25',isClosed:true}]},
    c_dataFeedUPSGroundPickupTimes:{monday:'16:00',tuesday:'16:00',wednesday:'16:00',thursday:'16:00',friday:'16:00'}}};
}
export const upsLocationHtml=(data:unknown=upsLocationFixture())=>`<script>pageProps: JSON.parse(decodeURIComponent("${encodeURIComponent(JSON.stringify(data))}"))</script>`;
