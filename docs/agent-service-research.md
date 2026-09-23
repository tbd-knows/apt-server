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

Reading documentation is not MCP protocol discovery. The next step is inspection
of an actual user-authorized service endpoint, authentication/connection where
supported, and execution with exact approvals and canonical reconciliation.
Unsupported/credential-required services must remain explicit blockers. In
particular, the [official UPS MCP](https://github.com/UPS-API/ups-mcp) documents
tracking/address validation and application credentials; its existence does not
prove a label or booking capability. No arbitrary downloaded MCP code is installed
or run by this research path.
