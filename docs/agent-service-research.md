# Agent-led service research

The owner supplies a discovery postcode in Actions and is told that public search
services receive it. Full transaction addresses are not used in search. The
owner's agent calls `apt_commerce` with `action: research`, the exchange identity
and `kind: nearby`. The server creates the query, so a model cannot insert private
memory, budgets, arbitrary addresses or credentials into a search string.

The query does not prescribe a carrier. An actual sample-postcode probe returned
both UPS Store and FedEx sources. If the saved packing information says no
printer, the query includes label printing. Search snippets establish neither
service compatibility nor postage availability.

The resulting owner-private Postgres job runs through the isolated Hermes
gateway's commerce plugin. It uses the pinned Hermes DDGS provider and
`ddgs==9.16.0`, requiring no additional provider key. Jobs, retries, leases, result
IDs and source timestamps persist across restarts. Completion wakes the owner's
agent; pending research should end the current model turn rather than poll.

The agent can request a capability-documentation search for a returned source's
domain, or read a returned source. These requests use immutable research/source
IDs; the model cannot supply arbitrary URLs or queries. A new discovery area
invalidates the old area's sources for subsequent research. Each area permits 12
jobs, with three automatic attempts per job. A failed job remains visible and its
owner may authorize one further attempt.

Public document retrieval accepts HTTPS, resolves only global addresses, pins the
resolved address while preserving TLS hostname verification, refuses redirects,
and sends no cookies or credentials. It accepts only bounded text/HTML/JSON,
removes scripts/styles from HTML text and records source links. Remote errors are
reduced to a generic failure. Public text remains untrusted model data.

All research rows force RLS and revoke direct client access. API projections,
leases and completion check owner and commerce mode. Stable lease IDs reject
late results from a superseded attempt. Results are explicitly marked
`verifiedForFulfillment: false`; no research write modifies an offer, payment,
shipping state or provider operation.

## Validation

- `test:research-db`: real disposable Postgres covers public-query boundaries,
  concurrent deduplication, private/foreign/mode denial, receipt replay, lease
  replacement, bounded failure/retry and changed-area rejection.
- `test:research-safety`: standard-library Python checks public URL validation,
  mixed/private DNS denial, HTML extraction and error redaction; no network.
- `APT_RESEARCH_NETWORK_CHECK=1 npm run test:hermes-a2a`: optional actual network
  check on a public sample postcode, through a running isolated Hermes gateway,
  recorded separately from the deterministic model in `hermes-a2a-results.json`.
- An actual source-read probe retrieved the official UPS MCP repository and found
  `track_package` and `validate_address`. No UPS connection or label purchase was
  performed.

## Remaining implementation

Owner-approved remote MCP inspection is now implemented as described below.
Remote OAuth connections now support owner review, public-client registration,
PKCE, encrypted credentials, rechecking/refresh and disconnection as described
below. Fulfillment execution with exact approvals and canonical reconciliation
remains necessary before this workflow can ship an item.
Unsupported/credential-required services must remain explicit blockers. In
particular, the [official UPS MCP](https://github.com/UPS-API/ups-mcp) documents
tracking/address validation and application credentials; its existence does not
prove a label or booking capability. No arbitrary downloaded MCP code is installed
or run by this research path.

## Shipping evidence contract under integration

`shippo-evidence.ts` implements typed receipt checks against the optional hosted
Shippo service's [operation reference](https://github.com/goshippo/ai/blob/main/skills/shippo/references/tool-reference.md),
[response envelope](https://github.com/goshippo/ai/blob/main/skills/shippo/references/response-envelope.md)
and [published OpenAPI](https://docs.goshippo.com/spec/shippoapi/public-api.yaml).
Free address validation and shipment/rate creation/retrieval now consume this
contract through the approved service-action harness. Paid label execution is
not yet wired into the commerce worker. Generic service execution remains denied.

The component builds shipment parameters from server-resolved private forms,
without silently rounding dimensions. Receipt checks bind provider account,
test/live mode, operation metadata, shipment/rate/parcel identities, exact postal
inputs, USD minor-unit amounts and rate age. Returned rate evidence omits full
addresses, provider account identity and raw response bodies. Material address
corrections require the private owner form to be corrected before acceptance.
Queued/error/refund states remain distinct from a purchased label. The supported
domestic no-printer artifact contract requires a requested, provider-issued USPS
printing QR; a PDF or tracking barcode does not satisfy it. Artifact URLs remain
private and require a separate bounded downloader before mobile delivery.

The [hosted MCP documentation](https://docs.goshippo.com/guides/mcp-server) says
rate comparisons and address validation are free, but label purchases use a live
account and hosted MCP has no separate test mode. Test-commerce approval must
never authorize live postage. This component's fixture coverage of both modes is
not a claim that hosted Shippo supports sandbox calls.

Remaining integration must resolve the actual authenticated meta-tool schemas,
bind the approved seller-paid/Stripe-reimbursed funding to a verified service account and provider-confirmed Stripe payment,
persist operation identity before dispatch and reconcile ambiguous outcomes.
The metadata field used here is a correlation identifier, **not** provider
idempotency. Do not replay a purchase because parsing or transport failed. A rate
and artifact alone do not verify a compatible drop-off location or delivery.

## Two-owner shipping data consent

The seller's agent can prepare `propose_shipping_data` with a connected service
reference through the existing owner-approved action mechanism. Confirming that
proposal asks both owners to review their own private shipping form. The app
names the exact endpoint and explicitly explains that data sent through the
seller's service account may be retained there and visible to the seller.

Each human must separately approve the current proposal digest and acknowledge
that access. The existing exchange aggregate stores only the service connection,
its generation, private input version numbers, expiry and owner approvals; it
does not duplicate the addresses. Participants see only their own address in the
review card. Agents see readiness and consent state, never either full address.
Approved proposal/decision references reach the peer through Hermes A2A. Private
shipping inputs do not appear in those messages or events.

Consent permits only free validation/rate lookup for this exchange, lasts at most
30 minutes, and never enqueues a quote, purchase or financial operation by itself.
Withdrawal, changed address/packing versions, changed/disconnected service access,
expiry or a closed/paid exchange prevents further use. A server-only helper checks
both approvals and resolves the private inputs while holding the exchange and
connection locks. The typed address-validation path now uses this helper at its
durable dispatch boundary. Rate/label execution still needs its own integration.
Withdrawal cannot erase data already disclosed to an external service.

`test:shipping-consent-db` covers real PostgreSQL persistence, model/human and
owner/peer isolation, exact digest and acknowledgment, two distinct approvals,
withdrawal, replaced proposals, input/generation/expiry changes and disconnect.
It also drives the actual MCP SDK against a deterministic endpoint fixture,
asserts durable claim before disclosure, private correction routing, separate
purpose approval, no duplicate dispatch and consent withdrawal during preflight.
No payment/shipment fact changes.

## Free address validation through a connected service

The seller's agent can request `prepare_shipping_validation` with the exchange,
current revision, connection, consent, successful description-action ID and an
address role. The model cannot supply address values or arbitrary tool arguments.
Both owners must already approve their private input versions. The server reads
the private form and constructs the documented v2 `ValidateAddress` inputs.

The current optional implementation admits only Shippo's official HTTPS endpoint,
the actual inspected `shippo_read_execute_tool` with the supported flat
`name`/`arguments` schema, and a stored successful description naming
`ValidateAddress` as a read with compatible string address inputs. Unsupported
wrapper/description formats fail closed; they are not guessed. These protocol
shapes are tested fixtures; actual authenticated hosted-schema compatibility
remains unverified until an owner connects the service. Description metadata
cannot admit a different operation, a paid read, address creation or postage.

The seller then reviews a free-validation action. Approval of metadata discovery
cannot approve this purpose. A fresh MCP session rechecks the actual tool schema;
immediately before the sole dispatch attempt, the server locks and checks both
consents, private input versions/values, service credentials and current exchange.
Withdrawal during preflight prevents disclosure. Timeouts after dispatch remain
uncertain and are not silently retried.

The provider's v2 envelope must echo the expected original postal input. The
agent receives only `valid`, `invalid` or `correction_required`. Corrections are
saved only in the affected owner's private form, without applying them; raw
provider payloads are discarded. Service-action projections independently omit
private arguments and allow only the validation status from results. This
validation sends no phone number because v2 does not accept it. It uses the
owner's live hosted service account, even for a test-commerce record, and cannot
create an address record, rate shipment or postage. That distinction is visible
in the approval card. No real account has been authorized or called in validation.

## Owner-approved MCP inspection

The agent proposes `kind: inspect_mcp` using an existing research/source ID for an
observed public HTTPS endpoint. Source reading retains public URLs appearing in
plain text/code as well as hyperlinks, so an endpoint does not have to appear in
a search snippet. The model cannot submit a made-up endpoint or a credential.

The proposal becomes an owner-private `awaiting_approval` action. Mobile displays
the exact endpoint and explains what will be sent: an MCP handshake and tool-list
requests, without credentials or transaction details. The owner can allow or
decline. The server checks owner, exchange, mode, current area and an immutable
inspection digest. Agent tools cannot submit this decision. Approval of inspection
does not approve a service connection, personal-data disclosure, or purchase.

The database worker uses the pinned MCP SDK's Streamable HTTP client. It performs
initialization and bounded, paginated tool discovery, retaining tool names,
descriptions, schemas and a catalogue digest. It does not compile untrusted output
schemas or execute tools. The client advertises no roots, sampling or elicitation
capabilities. Server instructions and error prose are not retained. A 401/403 is
recorded as authorization required, not as a successful connection.

HTTPS requests validate and pin public DNS answers while preserving TLS hostname
verification, reject mixed private/public answers, credentials, redirects and
cross-endpoint requests, and bound response bytes, pages, tools and time. Both
JSON and SSE responses are supported. Local stdio installations are not executed
from research documents. Unsupported endpoints remain visible failures.

Approval, attempts, lease, timestamps and outcome persist. A fresh worker can
resume after a crash; concurrent workers cannot claim the same active job.
Inspection has no financial side effects. Changed discovery areas and closed
exchanges invalidate unstarted work. Results wake only the owner agent and remain
`verifiedForFulfillment: false`. A catalogue reports capabilities, not provider
identity, safe/idempotent execution, paid postage or drop-off compatibility.

Validation: `mcp-inspection.test.ts` exercises the real SDK against local HTTP
fixtures (JSON, SSE, pagination, hostile sampling request, auth failure and limits).
`public-http.test.ts` uses a temporary HTTPS fixture certificate to exercise TLS,
DNS pinning, redirect/credential/response limits. `test:mcp-inspection-db` verifies
the owner decision, denial, private/mode isolation, model-forgery rejection,
concurrent claims, restart recovery, changed-area rejection and retained forced
RLS against disposable PostgreSQL. These are engineering fixtures; no carrier
account or postage purchase is implied.

Protocol reference: [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and [tool discovery](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Service account connections

For an inspected endpoint requiring authorization, the owner selects “Review
connection requirements.” The server discovers protected-resource and issuer
metadata using the pinned MCP SDK. It validates the resource audience, issuer,
public HTTPS endpoints, PKCE S256 and public-client compatibility. The UI shows
the service endpoint, account provider, sign-in endpoint and requested scopes.
A wildcard is explicitly described as full account access. The owner approves
this exact metadata digest before any client registration or browser flow.

Supported authorization is an OAuth public client: client ID metadata documents
when supported, otherwise dynamic client registration. Providers requiring
pre-registered/confidential clients, custom API keys or local stdio credentials
remain unsupported by this connection path and are shown as such. Nothing
silently installs downloaded code or invents a successful connection.

`APT_PUBLIC_URL` supplies `/commerce/connections/client.json` and the HTTPS
`/commerce/connections/callback`. The same existing server root secret
`HERMES_KEY_SECRET` derives a domain-separated AES-256-GCM credential key; no new
provider-wide key is required. Back up this root secret securely. Changing it
requires reconnecting existing service accounts unless an explicit credential
rotation/migration is implemented. Credentials, PKCE verifiers and temporary
authorization URLs are encrypted and bound to connection/owner/exchange/mode/
endpoint. Neither agent state nor mobile GET responses contain them.

The browser state is random, hashed in its lookup column, expires in ten minutes,
and is consumed once before exchanging the code. Tokens are immediately saved
encrypted before a post-authorization tool inspection. Account access is shown
as connected only after that authenticated protocol check succeeds. Credentials
reflected verbatim by a remote tool catalogue are removed from retained results.
Callback responses contain no remote prose, code or state; app request logs omit
query strings. Configure the deployment ingress to omit callback query strings
from its logs too. Never log request/response bodies or authorization headers.

Owner-triggered rechecking refreshes expired access tokens through the approved
issuer endpoint. A changed tool catalogue gets a new digest. Failed refresh
requires reconnection; it does not grant execution permission. Disconnect deletes
stored credentials and fences late requests using a generation ID. It does not
reverse purchases or revoke the provider-side OAuth grant; the UI points the
owner to provider account settings for that additional step.

Connection results and owner wake messages commit together. The existing worker
converts abandoned discovery/authorization/exchange waits into visible recovery
actions and invalidates stale callbacks. It does not blindly replay code exchanges
or rotate refresh tokens after uncertain results. Repeated recovery does not
produce duplicate notifications. All connection rows force RLS, deny direct
client access and retain owner/mode checks on every route.

Validation: `connection-oauth.test.ts` exercises SDK discovery, PKCE/resource/
scope binding, metadata clients, dynamic registration, token refresh, audience/
issuer denial and authenticated encryption. `test:connections-db` exercises real
Postgres persistence across separate service instances, replay/expiry/foreign/
mode rejection, exact metadata approval, credential isolation, refresh failure,
disconnect races and durable recovery. API tests reject third-party users before
connection access. No fixture represents a real authorized provider account.

Read-only external probes on September 24, 2026 found:

- Shippo's hosted `https://mcp.shippo.com/` and `/mcp` returned authorization required.
  The new SDK-based discovery obtained resource `https://mcp.shippo.com/`, issuer
  `https://goshippo.com/`, authorization/token/dynamic-registration endpoints and
  scope `*`. No registration, credentials, authorization or shipment was attempted.
  [Shippo's official guide](https://support.goshippo.com/hc/en-us/articles/51285219216283-Using-Shippo-MCP-Connect-Shippo-to-AI-assistants)
  documents hosted OAuth and label/rate workflows. Actual account capabilities,
  test/live mode, idempotency, funding, printing and drop-off still need verification.
- EasyPost's hosted MCP endpoint returned authorization required and a resource
  metadata hint; OAuth discovery failed. Its [current official MCP guide](https://docs.easypost.com/guides/mcp-guide)
  requires a production API key and documents read-only tools. It is not evidence
  of an OAuth label-purchase path and is not a mandatory platform integration.

Authorization reference: [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Approved capability operations

Some MCP services expose a meta-API: the initial catalogue describes wrappers,
and the agent must call a discovery/description wrapper to learn the actual
operation schema. `prepare_service_action` now persists an owner-private proposal
with the exact connected endpoint, tool schema, arguments, explanation, exchange
revision, connection generation, digest and fifteen-minute expiry. The mobile
Actions view shows those details and requires an explicit authenticated decision.
The agent can prepare but cannot approve or dispatch.

The current verified execution policy admits only `shippo_list_tools` and
`shippo_describe_tool` at the official Shippo hosted endpoint. This is an optional
service discovered by the agent, not a required account or platform credential.
The [official operation contract](https://github.com/goshippo/ai/blob/main/skills/shippo-best-practices/SKILL.md)
distinguishes those metadata operations from its read and write execution wrappers.
Arbitrary execution wrappers remain denied: even a read can be billable. The
separate typed address/rate paths below admit only their verified nested operations. A human's
approval of arbitrary tool arguments cannot replace the offer's exact monetary
terms, verified payment or postage authorization. New service policies require a
verified semantic contract, not a remote `readOnly` annotation or model claim.

Before dispatch, the server initializes a fresh authenticated SDK session,
reloads the bounded catalogue and compares the exact tool schema and description.
It then rechecks the exchange revision, connection generation, credentials,
expiry and persisted approval before recording `running`. No network request
holds a database transaction open. The transport permits at most one tools/call
attempt; even the SDK's session-expiry recovery cannot replay it. Changing or
disconnecting the account before dispatch invalidates approval.

The private receipt retains bounded text/structured content, removes verbatim
credential reflections and wakes only the owner's agent. Remote resource links,
images and other attachments are not fetched. A returned response is untrusted
data, not a confirmed shipment or payment. Tool errors and ambiguous transport
failures remain visibly unresolved. After a crash, the worker expires an
unstarted check or marks an already-dispatched call uncertain; it does not retry.
Repeated approval requests return the durable record. Identical operations are
deduplicated; there is currently no generic repeat/reconciliation override.

Validation: `mcp-execution.test.ts` uses the actual SDK with deterministic JSON/SSE
fixtures, schema changes, failed approvals, session/auth/server failures and
oversized receipts. `test:service-actions-db` combines SDK calls with disposable
Postgres and checks owner/mode isolation, duplicate taps, exact replay, expiry,
revocation during preflight, credential expiry, crash recovery, private receipts,
forced RLS and unchanged financial/shipping state. No real service account or
financial operation has been executed.

Still required: integrate rate selection into exact offers and implement paid
label execution contracts using the persisted seller-reimbursement settlement and both exact approvals; persist
canonical provider evidence, reconcile uncertain purchases, and verify artifacts,
compatible drop-off, no-printer support, tracking and resolutions. Shippo's hosted
MCP currently documents live-account purchases and no test mode, so a simulated
fixture is not a real shipping sandbox run.


## Free rate creation and pending-result retrieval

After both current addresses have valid receipts under the same two-owner
consent, `prepare_shipping_rates` resolves addresses and packing server-side.
The seller reviews a free `CreateShipment` operation against the actual observed
write-wrapper schema and stored operation description. This creates a shipment
record in the live service account; it does not purchase a label or select a rate.
No address, amount, provider identity or arbitrary shipment ID is accepted from
the model. An unsupported authenticated schema remains a visible blocker.

The action ID is persisted before dispatch and becomes operation metadata.
The initial authenticated reply establishes the account identity privately;
subsequent retrieval pins it along with shipment ID and original operation.
Addresses, parcel, mode, metadata, rate IDs/amounts/currency/age are verified
before the agent receives rate options. Raw replies and private addresses are
discarded from stored results; account identity stays in the server-only receipt.
Public action projections allowlist rate fields and omit account identity.
Provider display fields reflecting private form values are rejected.

For a pending result the agent first describes `GetShipment`, then prepares
another reviewed rate action with the pending `sourceActionId`. The server
supplies the proven shipment ID. This never creates another shipment to poll.
A new turn cannot duplicate a creation under the same consent, and an uncertain
create stays unresolved. Expired/stale unsent reviews can be replaced. Changed
consent, forms, connection or revision prevents dispatch. The same safeguards
are checked after fresh SDK catalogue inspection to cover withdrawal races.

All hosted-service rate evidence explicitly says `providerMode: live`, including
inside test-mode commerce. The result does not create a commercial offer, queue
checkout, buy postage or change payment/shipping state. Rates alone do not prove
printing, drop-off compatibility or delivery. Those steps remain under development.

`test:shipping-rates-db` exercises actual MCP SDK HTTP against fixtures with
real disposable Postgres: both validated addresses, exact private arguments,
creation/polling, integer USD amounts, pending states, expired review recovery,
duplicates, uncertain dispatch, changed account rejection, preflight withdrawal,
private projections and unchanged financial/shipping state. CI runs this suite.
The fixture wrapper/description shapes have not been verified with an authenticated
production Shippo account; this is not a claim of real provider acceptance.


## Private paid artifact delivery

`shipping-artifact.ts` downloads only a URL supplied by a reconciled provider
transaction. It permits the exact signed query without exposing it in errors or
mobile responses, validates/pins public DNS, preserves TLS hostname verification,
sends no account credentials/cookies, refuses redirects/compression and bounds
time and bytes. The existing paid EasyPost PDF route now uses this transport.
The sender/mode/payment/approved-shipment checks still run before downloading.

PDF and provider printing-code PNG are distinct typed responses. PDFs require a
header and end marker. PNGs are decoded under pixel/byte limits and re-encoded
losslessly to remove metadata without resizing or cropping. This validates bytes,
not whether an arbitrary image is a valid printing QR: provider-issued semantics
must come from the independently reconciled paid transaction. The Shippo paid
worker integration is not yet implemented, so this component does not itself
make a discovered-service QR available.

Mobile keeps PDF sharing and printing-code display separate. A PNG printing code
can be shown directly in a white, uncropped view on the phone and is removed from
view when the app backgrounds or the exchange changes. PDF cache files use unique
names and are deleted after sharing. No signed provider URL is sent to the device.
Physical scanning and real provider artifact compatibility remain unverified.


## Resuming older service receipts

Agent state keeps five recent private actions. `serviceActionHistoryCursor`
identifies the oldest visible receipt when earlier ones exist. The read-only
`service_history` tool action takes exchangeId and optional beforeActionId,
returns five receipts newest-first, and provides nextBeforeActionId. It checks
owner, exchange and mode on both the page and cursor; it cannot read peer receipts.
All pages use the same private-data-minimized projections as current state.

Ordering compares PostgreSQL (created_at,id) directly, preserving microseconds
and stable paging when timestamps tie. This lets an agent recover an earlier
operation description or pending shipment without inventing a reference or
repeating an external operation. Real-database tests cover complete traversal,
timestamp ties, foreign/unknown cursors, mode isolation and state continuation.


## Checking an agent-selected carrier option

`prepare_shipping_option` takes an actual rateActionId/rateId and a stored
GetCarrierAccount description. The server resolves the carrier account from the
verified rate; the model cannot supply an arbitrary account ID. A separate human
review permits a free read, with no address disclosure, account change, rate
acceptance or postage purchase. Source owner/exchange/mode/connection generation,
current consent and rate expiry are checked again immediately before dispatch.

The authenticated reply must match the selected account, established Shippo
account owner and live mode and report active=true. Only carrier token, rate/account
references and explicit live-provider mode are retained; account parameters and
raw replies are discarded. An inactive/mismatched account remains unresolved.
A carrier identity does not itself prove printing or drop-off compatibility.


## Approved seller-paid postage funding

The founder chose seller-paid postage reimbursed through Stripe. The server now
persists this policy on a versioned offer, includes its derived reimbursement and
total seller transfer in both approval bindings, and uses the same integer-money
calculation for Checkout, canonical transfer/reversal verification and attributable
payout reconciliation. For a $50 item and $15 postage, the buyer pays $65 before
any disclosed taxes/fees and Stripe transfers $65 to the seller, of which $15
reimburses postage. The seller shipping service charges the seller separately;
Stripe bank payout need not have arrived. No extra commission is introduced.

Historical offers without the new field remain platform-funded; published
platform-adapter offers explicitly record that policy. A funding change creates
a new version and invalidates approvals. Full refund/reversal verification
requires reversing the reimbursement too, while a carrier postage refund remains
separate. Mobile shows the exact breakdown and these consequences to either role.

This is financial-contract integration, not completed connected fulfillment.
There is no exposed model/client action that can invent a shipping offer or set
its funding. The legacy platform-account worker rejects seller-funded Checkout
creation and label operations rather than paying the same postage twice.
Remaining work includes publishing a verified connected offer, dispatching its
paid label action, reconciling it, and integrating artifact/tracking/refund/return
operations. A selected rate alone does not authorize any of those actions.

## Verifying an observed public drop-off location

`verify_dropoff` takes only exchangeId/current revision, a completed carrierActionId,
and saved researchId/sourceId. It resolves the actual selected rate and observed
location URL on the server. The evidence is private to the seller and bound to
that rate, carrier/account, connection generation, both owners' disclosure consent,
address/package versions and current discovery area. It expires no later than the
rate or consent. A second transaction rechecks the complete binding after public
network I/O; changed inputs cannot produce a current saved result. Duplicate
verification of current evidence reuses the saved result. No lock spans HTTP.

The first supported public source is an actual `local.fedex.com/en-us/...` location
page for FedEx Ground and a printed PDF. The server reads its public entity ID
without executing JavaScript, then reads the same site's public entity document.
That document must identify the exact page/location, confirm an operating
Ground drop-off, publish an address and complete regular hours, and accept the
parcel under carrier and location limits. Unhandled holiday exceptions fail
closed. QR returns never establish outbound label printing. Other carriers or
services remain research candidates until their own evidence contract is supported;
this does not require a FedEx account or force the seller to choose FedEx.

Anonymous HTTPS uses public DNS validation/pinning, normal TLS validation, bounded
response sizes, a 15-second request deadline, no redirects, no ambient credentials,
and no script execution. The only permitted query is a server-derived public
entityId. Neither a private address nor a service account token is sent. Public
HTML is capped at 1 MiB and location JSON at 3 MiB; MCP response limits stay at
1 MiB. Only normalized location facts are saved, never the carrier's full payload.

On 2026-09-25 at 07:18 UTC the production verifier fetched and parsed the actual
[New York WTCA official location](https://local.fedex.com/en-us/ny/new-york/wtca)
and its public entity document successfully without credentials. This was a public
source probe with a synthetic printed-label parcel, not a founder's chosen location
or a purchase. Ground size constraints are documented by
[FedEx Ground](https://www.fedex.com/en-us/shipping/ground.html).

Unit and real TLS tests cover service/page identity, malformed hours, closure,
package limits, no-printer refusal, bounds, redirects, private DNS and credential
rejection. The real-Postgres rate suite covers ownership, source selection, a human
area change during HTTP, stale rate/consent, persistence, replay and private-data
projection. Authenticated Shippo responses in that suite remain fixtures.

The agent and seller Actions card expose current/stale compatibility, source,
regular local hours, map, check time and expiry. This does not assert closest
location, current opening, appointment, final offer, purchased postage or delivery.
Connected offer publication, paid dispatch/reconciliation and tracking/refund/return
integration remain required before this path can complete an exchange.
