/** Synthetic location in the observed public USPS detail-page format. */
export const uspsLocationUrl = 'https://tools.usps.com/locations/details/1234567';
export function uspsLocationFixture() {
  return { poDetail: [{ locationID: '1234567', locationName: 'FIXTURE POST OFFICE', locationType: 'PO',
    address1: '100 Fixture Ave', address2: null, city: 'New York', state: 'NY', zip5: '10001', zip4: '0001',
    closedFacility: false, emergencySuspended: false, suspended: false, showNotice: null, specialMessage: null, error: null,
    services: ['CARRIER', 'LBRORETAIL'], serviceHours: [{ name: 'BUSINESS', starting: null, ending: null,
      hours: ['MO','TU','WE','TH','FR','SA','SU'].map(day => ({day, times: day==='SU' ? [] : [{open:'09:00:00',close:'17:00:00'}]})) }] }] };
}
export const uspsLocationHtml = (data: unknown = uspsLocationFixture()) => `<script>var dat = ${JSON.stringify(data)};\nrender(dat);</script>`;
