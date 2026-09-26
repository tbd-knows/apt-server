# Two-founder commerce pilot (TBD-12)

The agent-led implementation is undergoing acceptance; both PRs remain Draft. Hermes native A2A
delivery and durable private action preparation are implemented and tested with
two actual isolated gateways, Postgres and a deterministic model. Owner-scoped
service research now runs through the gateway using Hermes's keyless search
provider; source reads are bounded public HTTPS requests. See
[A2A implementation and evidence](hermes-a2a.md). The native harness joins 15 owner-agent preparations (nine sale and six return)
with authenticated human decisions and synthetic provider fulfillment,
receipt/settlement and seller-paid return recovery.
This does not establish live-model discovery or real-provider acceptance.

Stripe is the only mandatory commerce-provider integration. The EasyPost/FedEx
adapter documented below is an optional existing execution path, not the target
product's required setup. Dynamic source discovery, owner-approved remote MCP
capability inspection and owner-scoped OAuth connections are implemented with
fixture validation. Exact owner-approved metadata tool execution is implemented
for a verified discovery contract; generic financial tools are denied.
Both owners can approve exact private shipping-form versions for free
validation/rate lookup through a reviewed seller service account. Typed free
address validation now uses that consent, a separately reviewed action and the
actual MCP SDK; response corrections stay in the affected owner's private form.
Free rate creation and pending-shipment retrieval now run through the same
approved SDK harness, returning private-data-minimized carrier/price options.
Authenticated production schema compatibility remains unverified. Exact connected
offers, once-only paid label dispatch, private artifacts, tracking, and unused-postage
refunds are now integrated into the worker and exercised with SDK/Postgres fixtures.
Unchanged paid postage can receive fresh two-owner permission after expiry or original-account reauthorization, reusing only its original never-dispatched operation; price changes require refund and a new sale. Connected return preparation supports fresh consent, reversed private addresses, buyer packing and drop-off research. The buyer agent prepares an exact private return quote for the buyer to share. Both owners separately approve seller-absorbed return postage before one seller-account purchase. Private buyer artifacts, tracking, delivery/receipt, full original Stripe refund/reversal and unused-postage recovery are implemented; see [connected returns](connected-returns.md). USPS Ground Advantage supports a verified retail Label Broker no-printer path with canonical provider-issued PNG/PDF printing artifacts; actual provider purchase and physical scan acceptance are still unverified. Hosted-service rates are explicitly live-provider evidence even when
the surrounding commerce exchange is in test mode.
The [persistent single-host deployment](persistent-pilot-host.md) now includes
stable private routes, three supervised services, HTTPS routing, provisioning and
restart procedures, and read-only checks for both authenticated agents. Its
endpoint checks pass against the two actual local Hermes gateways. Deployment
to a real Linux host and reboot/provider acceptance are still unverified.
The founder selected seller-paid postage with Stripe reimbursement. Saved offer
funding, exact approval disclosures, Stripe transfer/reversal and payout amounts
now support it. The connected worker uses the seller account for approved postage;
the legacy platform-funded adapter refuses seller-funded checkout and postage.
See [service discovery and connections](agent-service-research.md). No founder
provider credentials are configured, and no sandbox payment,
real postage purchase, live migration or live transaction has been verified.

## Authority and baseline

- [TBD-12](https://linear.app/apt-knows/issue/TBD-12) and
  [TBD About](https://app.notion.com/p/3e3726cebd9081dfb051eeb563b53b10).
- Server: `7f97f7d73ad10607ebee0ef20f62138850d6a9f4`.
- Mobile: `8396b074d4254d2da9b0f3ab48b70b7f2c5ec17a`.
- Fetched September 23, 2026; both working trees were clean and current.
- TBD-11 is Done; server #5 and mobile #7 are merged. Historical migrations
  and all private memory upgrade behavior remain intact.
- Read-only Supabase check: `gmefzjlrvzmfcvlrxtco` ACTIVE_HEALTHY, six migrations.
  The issue's September 22 inactive observation is obsolete.

## Architecture and data plan

Keep one Fastify process and the isolated per-profile Hermes runtime. Durable
typed messages carry explicitly approved commerce information to the other
founder's agent. A waiting human action ends the current agent turn; the next
turn reads durable owner/participant state. No model gets both private histories.

The server owns authentication, the two-UUID allowlist, totals, versions,
approvals, inventory reservations and provider facts. Human HTTP commands and
model tools have different capabilities. Models cannot approve, spend, purchase
postage, or submit provider facts. Private budget/address input is separate from
the shared exchange. Only the owner's agent receives the owner's budget; full
addresses are excluded from model projections and counterparties' private data.

An agent can prepare one precise action per turn for its owner to review. The
draft persists privately with an actor-bound digest, exchange revision and
expiry. Human approval executes through the same guarded command path as a
direct action; it cannot bypass offer approval or payment checks. Human decisions
produce durable owner wake-ups; A2A messages wake only their recipients. A chat
turn reconciles private memory before completing and permitting a follow-up.

Forward migrations add exchange aggregates, quantity-one item reservations,
owner-private inputs/preferences, typed messages/action ledger, approvals,
provider operations and private asset metadata. All new tables force RLS and
revoke direct client access. Row locks serialize an exchange; a conditional item
reservation prevents the same item being sold through concurrent exchanges.
Network calls run outside database transactions. Operations are committed before
side effects and have unique business keys; uncertain outcomes reconcile first.
Existing chat restart failure semantics never replay commerce operations.

## Provider decisions and references

Engineering defaults: one physical item, domestic US, USD, card payments.
Founders must confirm location, eligibility and tax treatment before live mode.

- [Stripe destination charges](https://docs.stripe.com/connect/destination-charges)
  with hosted onboarding and Checkout. For the target connected-service flow,
  the seller pays postage and receives item price plus the approved postage
  reimbursement through Stripe. The buyer pays item + postage + disclosed
  taxes/fees. No commission; processing subsidy remains explicit. The shipping
  account needs available funds because a Stripe transfer is not immediate bank
  payout. Destination charges are not escrow.
  `offer.postageFunding` persists `seller_reimbursed` or `platform`; missing
  fields on historical offers retain their original platform-funded economics.
  Both human approval bindings include the new settlement breakdown, and their
  digest covers all offer fields. A changed payer or amount requires a new offer
  and both approvals. Seller-funded approvals also require an explicit API
  acknowledgement from the updated mobile review; older clients cannot silently
  approve funding terms they do not display. Canonical payment, transfer reversal and attributable bank
  payout must match item plus reimbursement for seller-funded offers. A full
  buyer refund reverses that full transfer; any carrier postage refund is a
  separate seller-account operation. Unexpected adjustments require a separate
  approved remedy, never an automatic extra charge.
  The optional existing EasyPost path still pays postage from the platform and
  explicitly publishes platform-funded offers. Its worker rejects seller-funded
  offers before creating Checkout or buying postage, so it cannot double-fund a
  shipment. Connected offers use the separate seller-account worker.
- [EasyPost shipments](https://docs.easypost.com/docs/shipments) for verified
  addresses, actual package rates, paid labels and tracking. Reconcile a known
  shipment after an uncertain buy; do not create another shipment to retry it.
- [EasyPost forms](https://docs.easypost.com/guides/form-guide): FedEx return QR
  does not establish generic outbound QR availability. Printable PDF is the
  initial supported artifact; a no-printer path must be resolved before approval.
- [FedEx locations](https://developer.fedex.com/api/en-us/catalog/locations/docs.html)
  must establish service/artifact compatibility, address and hours. A finder link
  alone is not verified automated drop-off selection.
- [Private Supabase buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
  store seller photos with participant authorization and bounded access.

See [the acceptance and ownership register](pilot-acceptance.md) for each
remaining verification gate and its required evidence.

## Live pilot prerequisites

| Owner | Required next action | Evidence needed |
| --- | --- | --- |
| Both founders | Confirm US origin/destination and actual item/condition | Structured private inputs and approved photos |
| Kebede | Configure two Auth UUIDs, persistent HTTPS and model | Both phones reach API; private Hermes endpoints |
| Platform operator | Configure Stripe sandbox/live platform and webhook | Account/mode verification; signed event delivery |
| Each seller | Complete hosted Connect onboarding | Charges/transfers enabled; payout status visible |
| Both founders | Confirm tax treatment and processing subsidy | Disclosed exact offer economics |
| Agent and participating founder | Discover a suitable service and authorize a supported connection when needed | Actual capabilities, eligible rate, funding, artifact and compatible handoff; fixed EasyPost/FedEx setup is optional |
| Bruk (first seller) | Pack, accept exact sale/postage, physically drop off | Carrier acceptance, separately from seller report |
| Kebede (first buyer) | Approve/pay, receive or report a problem | Provider payment, carrier delivery, buyer receipt |

Code checks and simulated providers do not establish sandbox or live success.
Only founders may merge the coordinated PRs. TBD-12 stays open until its required
human review and live completion evidence exists.

## Exact setup order

1. Use Node 22/npm 10.9.8 and the pinned per-profile Hermes release. Configure
   the retained Supabase/model variables in `.env.example`, plus exactly two
   comma-separated Auth UUIDs in `APT_PILOT_USER_IDS`. Provision both existing
   users with the retained lifecycle commands. Preserve private profiles.
2. Review the forward migration `20260923090946_pilot_commerce.sql` against the
   chosen environment, back up, and apply it through the normal migration process.
   Never run the disposable fixture scripts against a shared/live database.
   Apply `20260923125200_hermes_a2a_delivery.sql` as well. The server requires all
   13 migrations, through `20260926020019_connected_return_refunds.sql`, before
   starting commerce. Reprovision both profiles to install
   the commerce A2A plugin, then restart the gateways and server. Restart both
   gateway MCP children when updating the bridge schema, including the
   `prepare_connected_return` action.
   On a host installation, install `ddgs==9.16.0` into that Hermes Python
   environment; the container image includes it. This search path needs no API
   credential. Its upstream availability/rate limits still apply.
3. Create a **private** Supabase Storage bucket named by `APT_PHOTO_BUCKET`
   (default `pilot-photos`), maximum 5 MiB, JPEG/PNG only. Keep direct client
   Storage policies absent. Only the server service credential uploads/downloads.
   The server checks bucket privacy before upload; proxy responses use no-store.
4. Configure stable HTTPS as described in [the reachability guide](local-phone-stack.md#off-lan-api-and-webhook-reachability-tbd-10).
   `APT_PUBLIC_URL` is an HTTPS origin; `APT_MOBILE_API_URL` selects the phone API
   origin. Expose provider webhook routes and the public return page, explicitly
   deny `/internal/*`, and leave Hermes ports unpublished. For host processes the
   tool bridge is loopback-only. Exact private container peers must be configured
   separately; forwarding headers are rejected on the bridge.
5. Start with `APT_COMMERCE_MODE=test` and `APT_LIVE_COMMERCE_ENABLED=false`.
   Configure `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PLATFORM_ACCOUNT_ID`, and
   `STRIPE_CONNECTED_ACCOUNTS` as a JSON mapping of each founder Auth UUID to that
   founder's `acct_…` connected account. Create/choose supported connected accounts
   in the platform's Stripe setup; the app opens hosted onboarding for the mapped
   account. Confirm US/USD eligibility, requested transfers capability, charges
   enabled, bank details and access to automatic payout reconciliation. The
   adapter uses Stripe API `2025-02-24.acacia` and checks platform identity before
   creating Checkout. Sessions explicitly include `card` and `link` payment
   methods following [Stripe's Link guide](https://docs.stripe.com/payments/link/checkout-link).
   Enable Link in the relevant Stripe Dashboard payment-method configuration.
   Link availability and eligible funding sources remain Stripe-controlled;
   verify the actual hosted flow with sandbox credentials before live acceptance.
   Link does not replace seller Connect onboarding. Account readiness is visible in Profile.
6. Add a Stripe endpoint at `APT_PUBLIC_URL/webhooks/stripe`, subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, and `checkout.session.expired` in the
   chosen mode, and set its `STRIPE_WEBHOOK_SECRET`. Events wake canonical
   retrieval; their bodies never directly establish payment. Refund/transfer/
   dispute state is also checked by polling the canonical payment. Connected
   payout state is retrieved under the seller's account separately.
7. **Optional legacy EasyPost execution path only:** configure `EASYPOST_API_KEY`, `EASYPOST_USER_ID`, and the eligible
   `EASYPOST_CARRIER_ACCOUNT_ID`. Set an EasyPost webhook with an HMAC secret at
   `APT_PUBLIC_URL/webhooks/easypost`; put that secret in `EASYPOST_WEBHOOK_SECRET`.
   Keep EasyPost test versus production credentials consistent with the app mode.
   Confirm the account really returns a FedEx `FEDEX_GROUND` USD rate and printable
   PDF for the packed item; unsupported service fails visibly.
8. **Optional legacy FedEx location adapter only:** configure `FEDEX_CLIENT_ID`/`FEDEX_CLIENT_SECRET` with Locations access in the
   same chosen environment. The adapter queries the manually entered origin
   postcode and selects a staffed location with Ground drop-off/service evidence.
   Confirm sandbox fixture responses versus actual live location availability.
9. Both founders must confirm tax treatment, platform responsibility for Stripe
   fees/refunds/disputes, and postage funding. Set `APT_PILOT_TAX_MINOR` as integer
   USD cents, `APT_PILOT_TAX_TREATMENT` as the confirmed explanation, and
   `APT_PILOT_FEE_SUBSIDY` as the explicit processing-fee subsidy. Blank economics
   block quoting/checkout. This is manual pilot tax configuration, not a tax
   calculation engine. No TBD commission is collected.
10. Build the mobile development client after native dependencies change. Preserve
    Supabase OAuth redirect `aptmobile://auth/callback`; provider return uses
    `aptmobile://commerce-return`. Neither redirect is evidence of payment.
    Optional Expo push is not configured; the persisted unread inbox and foreground
    refresh remain the supported notification path without push permission.

After sandbox acceptance, switching live requires **both** the live mode setting
and explicit live enable flag, matching provider keys/accounts/webhooks, confirmed
economics and actual supported locations. Do not flip modes with unresolved
operations: the worker processes only its configured mode.

## Contracts and recovery

Authenticated routes are under `/v1/commerce`: list, inbox/read, preferences,
setup/onboarding, requests, exchanges/:id, exchanges/:id/actions, private photos,
and label/return-label. Create bodies use `{key, input}`; actions use
`{key, revision, command}`. `key` is a stable UUID per human command. A duplicate
returns the same persisted exchange; reusing it with different input is rejected.
The complete strict command schemas are in `src/commerce/domain.ts` and the
mobile projection is in `src/commerce/types.ts` in apt-mobile.

The server supplies exact approval bindings. The mobile card must return the
entire binding unchanged after human confirmation. The binding includes actor,
operation, exchange/offer version, amount/currency, address versions, service,
expiry and a digest of all offer terms. Material edits require fresh approval.
The model's `apt_commerce` tool can inspect scoped state, prepare private request/
item drafts, ask its owner, and suggest an inferred preference. It cannot call
human approval or provider execution paths. Runtime tool calls are capped at 24
per turn; negotiations at 12 shared turns. Confirmed/forgotten preference keys
cannot be overwritten by model inference. Forgetting erases the preference value
and keeps a value-free suppression record; historical chats/orders remain.

The worker checks every five seconds, serializes provider work per exchange with
a session advisory lock, and releases database transactions before network calls.
Provider requests time out; uncertain operations get at most five attempts, then
stay visible for founder review. Payment/label facts poll every 30 seconds;
payout and unused-postage refund polls use five minutes. Durable status messages
wake only the appropriate isolated owner agent. Failed chat runs never authorize
a new payment or postage operation.

| Situation | Operator action and evidence |
| --- | --- |
| Ambiguous mobile response | Use **Retry pending action**, retaining the original key across app restart. Do not prepare another command. |
| Provider outage | Restore credentials/connectivity and use **Reconcile this operation** with a reason. It opens one bounded reconciliation attempt, preserving side-effect history. |
| Checkout creation timeout | Retrieve the persisted session or reuse its Stripe idempotency key within 23 hours. After that, find the original session in Stripe and attach its reference for canonical verification; never recreate blindly. |
| Shipment creation timeout | Search EasyPost by the persisted operation reference, then attach that shipment ID. Reference/mode/input checks run before publishing a quote. No new shipment is auto-created after an uncertain creation. |
| Label purchase timeout/crash | Retrieve the same shipment. A persisted effect-start marker prevents a second buy. A late label is recovered; payment plus label failure remains visible and can be cancelled/refunded. |
| Corrected address/rate | Confirm the provider suggestion privately, save it, and request a fresh quote. Service/price changes invalidate approvals; no silent substitution. |
| Pre-handoff cancellation/payment race | Canonically expire/retrieve Checkout. A payment that wins the race queues a full refund with seller reversal. Inventory is released only after confirmed unpaid expiry. |
| Refund failure | Review/reconcile the same refund operation. A known pending refund is retrieved by ID, including beyond the creation idempotency window. Buyer refund and transfer reversal must both be confirmed. Partial external refunds/reversals or disputes require provider-dashboard reconciliation. |
| Unused postage | Separate label refund operation. Rejected carrier refund remains visible; both founders may explicitly approve absorbing that postage cost. It is never called a buyer refund. |
| After carrier acceptance | Record a problem and propose a remedy. Both founders approve exact refund/continue/return terms. No automatic dispute adjudication. |
| Agreed return | Connected sales require fresh two-owner disclosure, reversed addresses, buyer packing and a verified separate option. Both owners approve the exact seller-absorbed return postage before one seller-account purchase. Buyer-only artifacts and canonical tracking precede seller receipt and the full original refund/reversal; unused-postage cancellation/refund is separate. Historical platform-funded sales retain their separately approved legacy return path. |

Return address changes are deliberately blocked; resolve changed locations with
the founders before shipping. Connected free return preparation supports printed
FedEx/UPS Ground or verified USPS Ground Advantage retail printing. A generic QR
or pickup reservation is never inferred. Address/parcel correction, missing
capabilities and no-printer states fail visibly before commitment.

Stripe bank payout attribution uses automatic payout balance transactions tied
to the seller's destination payment. Manual/unattributable payouts remain
`unknown`; a transfer never becomes a claimed bank payout. This bounded pilot
search inspects ten recent payouts; older/unattributable payouts require operator
reconciliation in Stripe. Order completion requires paid funds, seller transfer,
carrier delivery and buyer receipt, while bank payout is displayed independently.

For a stuck operation, inspect only operation ID/kind/state and the sanitized
ledger. Keep provider dashboards and database inspection private; never paste
addresses, label links, raw webhooks or credentials into issue comments/logs.
Pending asset rows identify interrupted private uploads; confirm storage state
before removing unused artifacts. Do not delete any shared/approved evidence.

## Verification and rollout

- Node 22 typecheck/unit/build; real PostgreSQL 16 migration replay plus command
  and worker suites. Existing retired rows and private-memory upgrade behavior
  remain covered. CI now runs the commerce database suites as well.
- Deterministic negatives include forged/stale/replayed approvals, canary privacy,
  third identities, quantity-one contention, duplicated commands/webhooks,
  wrong account/mode/object/amount, stale tracking, crash-after-success recovery,
  cancellation races, failed refunds and separate reversal, returns and forgetting.
- Pinned Hermes harness calls the actual MCP commerce tool through a file-backed
  bridge fixture, pauses for owner input, restarts isolated processes and reads
  the persisted decision. The provider is a deterministic mock, not a live model.
- Mobile typecheck/tests/lint, iOS export, Expo Doctor, clean prebuild/pods and
  ARM64 Simulator Debug build. Built identity/deep links are preserved and no
  location/camera/microphone usage descriptions are present.
- Server dependency audit is clear after updating Sharp and compatible transitive
  patches. Mobile retains existing moderate advisories and Metro's high-severity
  image-size parser advisory; a forced major parser override would be incompatible
  with Metro's dependency contract. It processes build assets, not uploaded item
  photos (those are decoded by patched server Sharp).

Merge/deploy order after founder approval: server migration and server release,
then mobile. Verify `/health`, authenticated Profile setup, both isolated agent
profiles and private bridge denial before enabling a sandbox transaction. Keep
the API/worker and webhooks running across the whole shipment. To roll back, stop
new commerce approvals, reconcile existing provider operations, and roll back code
only; preserve the forward tables and provider references. Never drop pilot or
historical tables to undo a release.

Still unverified: provider sandbox/account onboarding, physical iPhone account
switching and two-phone cellular reachability, real-model product acceptance,
actual paid label/drop-off/carrier delivery, and live payment/refund/payout. These
need founder-controlled credentials, accounts, devices and physical actions;
engineering checks must not be presented as their completion.

### Connected public drop-off evidence

After an approved carrier-account lookup, the seller's agent may verify a saved
research location using `verify_dropoff`. The seller Actions screen shows the
public location and official source with current/stale status, hours and expiry.
Changing shipping inputs, disclosure consent, service connection, discovery area
or rate validity invalidates its binding. The first credential-free verifier
supports actual FedEx Ground and UPS Store Ground location pages for a printed label; it refuses QR
return claims, generic finder pages and unsupported services. No postage is bought
and no appointment is booked by this check. Exact connected offers and the paid lifecycle are implemented and fixture-tested;
actual provider-account compatibility remains unverified. See `agent-service-research.md` for the live public
source probe and deterministic/database evidence boundaries.

### Connected offer review

A seller agent can now prepare exact seller-reimbursed terms from a verified
location/rate/carrier. The seller reviews the item, total, reimbursement, tax/fee
treatment, printing, drop-off and deadlines before explicitly sharing the offer.
Both founders must separately approve its exact terms and connected-service
permission. Service account credentials and identity are not shared with the buyer
or model. Stale draft/connection/form evidence is rejected. Test-mode payments cannot
fund live postage. Payment is available only when the connected worker is installed
and the current service connection has verified descriptions for its complete
outbound lifecycle. No fallback platform postage is used.


### Real test accounts and connected shipping reads (September 25)

The optional authenticated Hermes check uses two dedicated Supabase Auth test
accounts through the production `SupabaseAuthService` and actual loopback HTTP
routes. Set `APT_TEST_ACCOUNTS_FILE` to an owner-readable-only JSON file containing
`project`, `runId`, `publishableKey`, and exactly two `accounts` (buyer then seller),
each with `role`, `id`, `email`, and `password`. Emails must follow
`tbd12-<runId>-<role>@example.invalid`; server-controlled Auth `app_metadata` must
match `tbd_test_run` and `tbd_test_role`. This prevents the harness from silently
using a founder's identity. Do not commit this manifest or pass passwords in CLI
arguments. The test uses password sign-in, verifies each identity, and signs out
its sessions. It requires no local service-role key and sends no email.

Run `test:local-db` against the disposable loopback PostgreSQL immediately before
`test:hermes-a2a`, with the manifest variable and the pinned `HERMES_CLI` set. The
local FK mirrors and agent profiles are disposable; production pilot UUIDs,
founder grants, commerce rows, and migrations are unchanged. The report
`docs/hermes-auth-a2a-results.json` records the actual authenticated run. It checks
private draft denial, duplicate request identity, authenticated sharing, native
Hermes delivery, seller-only prepared-action approval, private canaries, hostile
peer denial, and restart recovery. Its model is deterministic. This is not a
live-model, phone, payment, or physical shipping acceptance run.

`ConnectedShippingRead` executes only `GetRate`, `GetCarrierAccount`,
`GetTransaction`, `GetTrack`, and `GetRefund` through the authenticated MCP SDK.
Each operation requires an observed description and the current catalog schema;
connection ownership, offer identity and revocation are checked before dispatch
and after the response. Arguments derive from the offer or recorded operations.
Canonical rate checks reject changed prices/services/accounts. Transaction,
tracking and refund receipts must match their persisted identities; raw account
identities, addresses, carrier prose and signed label URLs are not projected into
agent state. The seller label endpoint now retrieves a recorded connected
transaction's verified artifact through the existing private binary downloader.
It never falls back to platform-funded shipping for a connected offer.

Reconciliation reads may continue after the offer's spending deadline, or after
the same connection is reauthorized and its operations redescribed. The provider
receipt must still establish the original account and purchased object. This does
not renew spending approval: preflight still requires the original generation,
expiry and private form versions. Unknown/pre-transit tracking is not carrier
acceptance; a pending/rejected postage refund is not a completed Stripe refund.

The PostgreSQL shipping suite exercises these reads through the actual MCP SDK
with synthetic transport responses, including price/account mismatch,
revocation before and during a read, fresh-generation description requirements,
expiry, transaction/refund identity and private-output checks. No real postage
was purchased. The worker integration described below replaces the earlier blanket
payment gate with capability and payment checks. Seller-paid connected returns
and recovery are implemented and covered by both the SDK/worker fixtures and
six native owner-agent preparations.
Two test accounts do not remove the remaining live-model, Stripe, service authorization,
device, physical delivery, review and merge requirements.


### Connected paid worker and recovery (September 25)

The production server now wires `ConnectedShipping` into both the private artifact
endpoint and `CommerceWorker`. Before creating Checkout, human admission requires
live commerce, the original connected-offer authorization and actual current-generation
operation descriptions for GetRate/GetCarrierAccount/CreateTransaction/GetTransaction/
GetTrack/CreateRefund/GetRefund. Missing descriptions leave mobile payment disabled.
The worker revalidates rate, amount, service and carrier; no EasyPost/FedEx credentials
are used by this route. Test Stripe cannot fund a live hosted-service label.

Immediately before the one MCP purchase dispatch, the worker retrieves canonical
Stripe payment and seller transfer, rejects missing/partial/refunded/reversed funds,
and rechecks cancellation, both complete approvals, expiry, account generation and
private input versions. It durably records `effectStarted` under the exchange lock
before any purchase request. A known transaction is retrieved on restart; an unknown
outcome never permits a second CreateTransaction. The canonical transaction ID is
saved before parsing the PDF/QR so a malformed artifact cannot erase the purchase.
Cancellation or revocation racing a successful response does not discard that ID.

Purchased postage is saved before tracking polling. Tracking outages leave it
purchased; stale/pre-transit events cannot regress transit or delivery. Carrier
acceptance, seller drop-off, delivery and buyer receipt remain separate. Polling is
limited to the tracking number from this account's verified purchased transaction.
[Shippo's hosted MCP documentation](https://docs.goshippo.com/guides/mcp-server#live-account-and-charges)
identifies this tracking as free and externally purchased tracking as billable; the
latter is not admitted by this worker.

Unused-label refunds require a confirmed Stripe refund, no reported/observed handoff,
and canonical pre-transit evidence. A durable submission fence and transaction binding
survive successful polling and restarts. Pending, rejected and refunded postage stay
separate from buyer funds. An interrupted submission can reconcile from the original
transaction status or a verified refund ID, without another CreateRefund.

For a lost provider response, only the seller can enter the original transaction or
refund reference in the app's resolution card. It remains an unverified candidate
until the canonical account/mode/rate/operation or transaction binding matches. An
incorrect candidate can be corrected; a verified reference cannot be replaced. This
action never authorizes another purchase/refund. Routine projections exclude tokens,
account identities, addresses and signed artifacts.

`test:shipping-rates-db` also runs `connected-shipping-worker-check.ts` against the
same privately prepared and approved disposable fixture. It covers human checkout
admission and capability refusal, payment-to-label execution, concurrent workers,
restarts, payment/approval/revocation races, pending/malformed/unknown outcomes,
human reference correction and ownership denial, cancellation after dispatch,
tracking outage/order/delivery/receipt, refund pending/success/unknown recovery and
carrier-handoff denial. Provider responses remain synthetic; this is not a live
purchase or authenticated hosted-account compatibility claim.

Connected returns deliberately cannot fall through to the old platform-funded
return adapter. The separately approved [seller-paid connected return lifecycle](connected-returns.md) now handles reverse-shipment purchase and recovery. USPS retail no-printer verification, FedEx/UPS printed-label verification, account
refresh/reconnect, unchanged paid-postage renewal and persistent-host configuration
are implemented. The native positive fixture now joins agent preparation to
synthetic provider fulfillment; live-model and deployed-host acceptance remain. Founder-controlled
service authorization, Stripe onboarding/credentials, real payments, phones,
physical handoff/delivery and review/merge remain distinct acceptance steps.


### Connection lifetime, return preparation and UPS locations (September 25)

The worker renews expiring OAuth grants on active exchanges and unresolved postage
refunds. A same-scope refresh with the same inspected tool catalogue preserves the
original authority generation without extending any consent or offer deadline.
Changed scopes/catalogues and browser reauthorization invalidate old spending
authority. A concurrent disconnect fences late responses. An ambiguous refresh
is never replayed; the owner must reconnect. Omitted unchanged refresh tokens and
scopes are retained according to RFC 6749 section 6.

A paid or refunded exchange permits reauthorization of its original bound seller
connection. Current capability descriptions can be prepared again after a new
generation, including after cancellation. This enables known-transaction tracking
and refund recovery without granting another purchase.

A mutually approved return can now prepare a separate free shipping-data consent.
It binds the resolution, buyer return packing, reversed original address versions,
seller connection and a new deadline. Both owners approve independently. The
seller's agent uses the existing typed validation/rate/carrier tools; the buyer's
agent sees only approved public rate facts and performs its own postcode research
and location check. Old outbound receipts cannot stand in for return evidence.
Connected return-quote requests wake both agents instead of queuing legacy
platform postage. Preparation does not purchase postage. The subsequent
[seller-paid return lifecycle](connected-returns.md) requires two exact human
approvals and preserves the original payment until return delivery and receipt.

The public drop-off adapter also supports UPS Ground at an observed official
UPS Store page. It parses the public serialized profile without evaluating
scripts, checks location identity/open status, published Ground drop-off support,
package limits, regular and holiday hours, and the pilot's below-$1,000 value
limit. The app shows the handoff restrictions with the offer and drop-off. It
requires a printed prepaid label; listing a printing service does not establish
a free no-printer path. This does not require platform UPS credentials.

Sources checked September 25:
- [Official UPS Store location and drop-off FAQ](https://locations.theupsstore.com/ny/new-york/1632-1st-ave).
- [UPS package limits](https://www.ups.com/us/en/support/shipping-support/shipping-dimensions-weight/avoid-additional-shipping-fees).
- [Shippo carrier and service tokens](https://docs.goshippo.com/shippoapi/public-api/service-levels/other-supported-carriers).
- [USPS Label Broker](https://www.usps.com/business/label-broker.htm) requires a
  participating location. The earlier generic USPS locator URL returned a
  challenge; the current official `tools.usps.com/locations/details/<id>` page
  is readable by the existing bounded server transport, as verified below.

The actual server public-fetch transport and parser verified UPS Store #6584
(Ground/PDF, hours and restrictions) on September 25 at 16:16:51 UTC. That was a
read-only public lookup, not a booking or postage purchase. Automated tests use
synthetic pages and authenticated SDK fixtures. The return preparation database
test exercises a FedEx outbound order with a separately checked UPS return option.

## USPS retail Label Broker and no-printer artifacts

The server now accepts an observed official USPS detail URL for Ground Advantage.
It parses only that page's serialized `poDetail` JSON; scripts are never executed.
The exact facility ID, Post Office type, carrier service, non-suspended state and
regular retail hours must match. No-printer packing additionally requires the
specific `LBRORETAIL` service. Nearby facilities, lobby/kiosk hours and a generic
Label Broker page cannot establish this counter's capability. USPS Ground
Advantage's 70-pound and 130-inch length-plus-girth limits apply. Hours are shown
as regular local counter hours with a holiday/change notice.

The existing free shipment must have requested a QR printing code. A compatible
location still does not establish purchased postage: the worker requires canonical
Stripe payment, exact approvals and the purchased transaction's `qr_code_url`.
A missing QR never falls back to `label_url`, generates a tracking barcode or
submits another purchase. The existing transaction is retrieved until its original
artifact is available. Provider QR artifacts may be PNG or PDF. PNG remains
losslessly sanitized and displayed uncropped; a provider QR PDF keeps its separate
`label_qr` identity and opens through the phone's document sharing flow. Temporary
PDF files are removed after the sharing flow closes. No signed URL enters mobile
or model state. An exported/saved copy is managed by the receiving phone app.

On September 25, 2026, the production DNS-pinned transport fetched the official
[James A Farley location](https://tools.usps.com/locations/details/1433785), and
the parser verified retail Label Broker/hours for a sample shoe-box parcel
(`usps-1433785`, checked at 20:20:51 UTC). This was public information only; no
user credentials, shipment or postage purchase was used. Tests use synthetic
location/provider data and real Postgres/MCP execution: suspended/wrong locations,
kiosk-only evidence, stale inputs, QR request binding, separate return preparation,
missing-code recovery without repurchase, and private artifact handling. Physical
phone document viewing and a paid provider QR's counter scan still require the
agreed acceptance run.

Sources: [USPS Label Broker](https://www.usps.com/business/label-broker.htm),
[USPS Ground Advantage](https://www.usps.com/ship/ground-advantage.htm),
[Shippo transaction QR field](https://docs.goshippo.com/shippoapi/public-api/transactions/createtransaction).

### Seller-paid connected returns (September 26)

The delegated funding choice is implemented: seller absorbs the exact return
postage, with no additional buyer payment. See [connected returns](connected-returns.md)
for approval, purchase, private artifacts, delivery/refund, cancellation, recovery
and test evidence. The new operation-kind migration brings fresh replay to 13
migrations; live rollout still requires applying the pilot migrations.
