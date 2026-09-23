# Two-founder commerce pilot (TBD-12)

The agent-led rework is in progress; both PRs remain Draft. Hermes native A2A
delivery and durable private action preparation are implemented and tested with
two actual isolated gateways, Postgres and a deterministic model. See
[A2A implementation and evidence](hermes-a2a.md). This does not establish the
complete intelligent discovery/fulfillment experience.

Stripe is the only mandatory commerce-provider integration. The EasyPost/FedEx
adapter documented below is an optional existing execution path, not the target
product's required setup. Dynamic discovery, capability inspection, per-user
connection and funding/execution of alternative fulfillment are still being
implemented. No provider credentials are configured, and no sandbox payment,
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
  with hosted onboarding and Checkout. Seller receives the agreed item amount;
  shipping allocation stays with the platform. No commission; any processing
  subsidy is explicit. Destination charges are not escrow. Transfer and payout
  remain distinct facts.
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
   eight migrations before starting commerce. Reprovision both profiles to install
   the commerce A2A plugin, then restart the gateways and server.
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
| Agreed return | Original addresses reversed; buyer confirms new packing/printer access. Obtain a separate rate/drop-off, both approve additional platform-funded postage, then buy once. Carrier return delivery plus seller receipt triggers the agreed original full refund/reversal. |

Return address changes are deliberately blocked; resolve changed locations with
the founders before shipping. The first supported path is printed FedEx Ground
PDF, not a generic QR or pickup booking. Address/parcel correction, missing
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
