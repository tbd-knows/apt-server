# Seller-paid connected returns

The founder delegated the funding decision on September 26, 2026. For this pilot,
the seller pays and absorbs return postage through the original connected shipping
account. There is no second buyer Checkout, added reimbursement, or platform
postage charge. After canonical return delivery and the seller's receipt, Stripe
refunds the full original payment and reverses the original seller transfer,
including its outbound postage reimbursement. Processing fees and carrier
adjustments remain subject to the original disclosed/provider terms.

An agreed return starts with a separately approved resolution, fresh two-owner
private shipping disclosure, buyer packing, reversed original addresses, real
service rate/carrier evidence, and a verified buyer-compatible drop-off. The
buyer's agent prepares the exact quote; the buyer shares it. Both humans then
approve its price, carrier/service, artifact, drop-off, funding, address versions,
resolution, version and expiry. Sharing alone cannot purchase anything. Old
quotes whose funding was `unselected` must be prepared/shared again.

The durable worker buys the exact approved rate once through the seller's
connected service. It checks the original canonical Stripe payment/transfer,
current service contracts, account identity, private input versions, deadlines
and both approvals immediately before dispatch. Private evidence binds the
return independently of the paid sale. No connected return falls back to
platform-funded shipping. The supported reverse shipment uses a normal label
with reversed addresses, purchased only after a return is agreed; it is not a
pay-on-use label inserted into the outbound parcel. See the provider's
[shipment documentation](https://docs.goshippo.com/shipments/create-a-shipment)
and [return label distinction](https://docs.goshippo.com/shipments/returns).

Only the buyer can retrieve the private return PDF or genuine provider printing
code. Handoff reports are separate from carrier acceptance; provider events
advance return tracking without regressing delivery. Seller receipt requires
canonical delivery. Payment polling cannot turn an agreed return, or a newly
proposed remedy after handoff, into an early Stripe refund.

Recovery retains the original operation and provider identity. A lost purchase
response cannot authorize another purchase. The seller can attach the original
transaction reference, which is only a candidate until its account, mode,
metadata, rate and parcel are verified. Missing QR evidence does not silently
substitute a normal PDF. A failed, never-dispatched return can withdraw its
approvals and prepare a fresh quote; a known or possible purchase cannot.

For unused purchased postage, either participant can request cancellation. That
pauses label access and handoff instructions. The requester can withdraw while
the other person has not approved. Both exact approvals queue a distinct
`return_label_refund`; canonical carrier evidence must establish unused postage.
A lost refund response is reconciled, never resubmitted. A submitted or successful
postage refund does not refund the original Stripe payment. If the carrier
rejects it, only the seller can explicitly accept the postage cost under the
already approved seller-funded terms. After confirmed postage refund or cost
acceptance, both founders can agree the next remedy for the original sale.
Provider [unused-label refund rules](https://support.goshippo.com/hc/en-us/articles/201772785-Refund-a-Label-Created-in-Shippo)
still apply; a local cancellation cannot establish provider reimbursement.

Apply the forward migration `20260926020019_connected_return_refunds.sql` with the
other pilot migrations before running this version. It adds one operation kind
to the existing check constraint; existing rows, uniqueness, forced RLS and
server-only grants are unchanged. Local replay covers all 13 migrations. No live
migration has been applied by this work.

`npm run test:shipping-rates-db` exercises UPS PDF and USPS retail printing-code
returns through actual PostgreSQL, the MCP SDK, service and worker: exact and
stale approval binding, wrong-owner denial, lost purchase/reference recovery,
concurrent workers, changed rates, private artifacts, tracking order, receipt,
full original refund/reversal, fresh-quote recovery, two-owner unused-postage
cancellation/withdrawal, lost refund recovery, carrier-use refusal, and seller
acceptance of a rejected refund. Provider and location responses are synthetic.
These tests do not establish real hosted-account compatibility, real-model
judgment, physical phone/code acceptance, or a delivered shipment.

The native Hermes harness also runs this USPS return scenario: six actual
owner-scoped return preparations, followed by authenticated HTTP human commands,
approvals, recovery and receipt. It uses the same real PostgreSQL/SDK worker
checks with synthetic provider transport. The combined sale/return report records
15 native preparations and distinguishes synthetic boundaries.
