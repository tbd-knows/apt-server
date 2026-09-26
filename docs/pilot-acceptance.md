# TBD-12 acceptance and ownership register

This register separates implemented behavior from acceptance that still needs a
real model, authorized provider account, deployed host or physical participant.
It is not a completion certificate. Both PRs stay Draft until the agreed pilot
passes; only founders may merge. Keep this file current when new evidence changes
a gate. Never count a passing synthetic provider response as a real transaction.

## Verified engineering baseline

The native suite executes two isolated, pinned Hermes gateways, owner MCP calls,
authenticated human HTTP decisions, native A2A receipts and real disposable
PostgreSQL. Its model choices, OAuth/catalog authorization, photo storage, public
location responses, Stripe/shipping responses and artifact bytes are fixtures.
The optional real Supabase Auth mode verifies authentication, not real payments.

The reports [fixture identities](hermes-a2a-results.json) and
[real test-account identities](hermes-auth-a2a-results.json) each record 15 native
preparations: nine sale and six return. The native tests check decline/restart,
private canaries, exact human decisions and seller-paid return recovery. The
return artifact is checked at the private asset-service boundary; the outbound
artifact also passes through authenticated HTTP. Negative scenarios restore
local fixtures and do not represent a single real chronological shipment.

[CI for code baseline 07e4727](https://github.com/tbd-knows/apt-server/actions/runs/36242956969)
passed both `verify` and `native-agents`. The
[mobile baseline ffa561e](https://github.com/tbd-knows/apt-mobile/actions/runs/36210906415)
passed verification including Expo Doctor. Later changes require their own
appropriate checks; these links prove only the named baselines.

## Original example: requirement-by-requirement acceptance

“Implemented; real run pending” means there is engineering evidence, but the
corresponding real-world requirement is still unproven. Record the actual model,
account mode, build/commit, timestamp and sanitized evidence for each real run.
Keep addresses, credentials, private budgets and artifact URLs out of PR/issue
comments and this register.

| Requirement | Existing implementation and direct test evidence | Remaining proof | Work ownership |
| --- | --- | --- | --- |
| 1. Understand the Nike request, clarify sizing/style and private all-in budget. | `src/memory/prompt.ts`, `test/commerce.test.ts`, `scripts/harness-db-check.ts` enforce structured required inputs and private drafts. | A real model asks the missing questions, uses confirmed preferences and does not invent answers. Schema refusal alone does not prove model judgment. | Agent runs and evaluates; founder supplies model access and real preferences. |
| 2. Share only the owner-approved request through native A2A. | `scripts/hermes-a2a-check.ts` checks exact approval, receipt, private wake, wrong-token/foreign denial, duplicate protection and restart. | The same behavior with real model choices on the persistent host. | Agent executes after model/host access; buyer approves actual sharing. |
| 3. Ask the seller about unknown inventory; support decline without a listing. | `scripts/commerce-db-check.ts` and native decline scenario preserve seller-only preparation and approval. | Real seller inquiry without seeded inventory; honest decline and correction. | Agent evaluates; seller answers ownership and willingness. |
| 4. Share approved actual item/photos and bounded versioned terms. | `scripts/commerce-db-check.ts`, `scripts/hermes-positive-check.ts`, `test/commerce.test.ts` cover item/offer sharing, privacy and changed approvals. | Real photo storage/upload/viewing and model handling of actual item, defects, questions and counteroffers. Native photo data is seeded. | Agent verifies/fixes storage, API and app; seller supplies photos and approves terms. |
| 5. Gather private shipping forms and discover usable service/rates. | `test:research-db`, `test:mcp-inspection-db`, `test:connections-db`, `test:service-actions-db`, `test:shipping-consent-db`, `test:shipping-rates-db` cover discovery, OAuth/SDK, consent and canonical contracts. | Real model discovery plus compatibility of the actual owner-authorized service catalog, account, rate and location. Public source probes alone do not prove a purchase capability. | Agent researches/verifies/fixes; owners provide private forms and authorize their service account. |
| 6. Obtain separate exact approvals for full sale/postage economics. | Commerce DB and shipping suites bind owner, versions, integer amounts, funding, private input versions, service and expiry. | Both phones display and submit the real agreed terms; material changes invalidate consent. | Agent verifies UI/API; both owners decide terms, tax/fee treatment and spending. |
| 7. Complete hosted Stripe payment including Link and authentication. | `test/commerce-providers.test.ts`, `test/commerce-api.test.ts`, `test:commerce-worker` and connected worker fixtures check payment/account/mode, webhook and reconciliation boundaries. | Actual sandbox Checkout/Link, Connect onboarding, signed webhook delivery and canonical retrieval; approved live payment later. | Agent configures/tests/fixes with supplied access; founders complete identity/bank/payment authentication. |
| 8. Buy postage once and present a usable artifact and compatible drop-off. | `scripts/connected-shipping-worker-check.ts`, public carrier tests, artifact tests and native authenticated QR retrieval cover exact dispatch, unknown outcomes and private artifacts. | Actual account purchase/identity/artifact, correct displayed location and counter-accepted printing code or printable PDF. The current hosted-service contract uses live postage and cannot be funded by test Stripe. | Agent validates integration and prepares handoff; seller approves real spend and uses the artifact. |
| 9. Distinguish handoff, carrier acceptance, tracking and exceptions. | Connected worker suites exercise monotonic tracking, outages and saved purchased identity. | Physical handoff and real carrier events remain separate in both phone and agent views; real explanations reflect those facts. | Seller hands off; agent checks reconciliation/explanations and fixes defects; carrier supplies scans. |
| 10. Confirm receipt or problem, with payment/transfer/payout distinguished. | Connected worker and `scripts/connected-return-worker-check.ts` cover human receipt, original refund/reversal, return tracking, unused-postage refund and uncertain recovery. | Delivered founder shipment, buyer receipt, actual seller transfer and attributable bank-payout status; authorized remedy/refund verification. | Agent verifies records; buyer confirms receipt/problem, seller confirms any return receipt, founders approve remedies. |

## Cross-cutting acceptance gates

| Gate | Existing evidence | Still required and responsible party |
| --- | --- | --- |
| Owner isolation and authority | Auth/API/commerce DB tests; native private canaries and hostile/foreign denial; separate owner gateways. | Agent repeats checks against deployed configuration. Founders supply the two intended Auth identities; test accounts are not founder grants. |
| Private memory and preferences | `test/memory.test.ts`, `test/memory-upgrade.test.ts`, local migration replay and commerce preference checks. | Agent verifies real-model recall, inspect/correct/forget behavior and account switching; each owner supplies their own preferences. |
| Durable waiting and mobile retry | Harness DB, native restart, `apt-mobile/src/api/client.test.ts`, chat and commerce client tests. | Agent coordinates app-close/reopen, network loss and retry tests on the physical builds; founders operate their devices. |
| Persistent inbox with push unavailable | Durable owner messages, fair per-owner wake tests and app foreground refresh. | Verify discoverable unread actions with notifications denied. Expo push remains optional until its credentials/permission are supplied; no push delivery is claimed. |
| Persistent host and migrations | `test/pilot-host.test.ts`, CI systemd unit validation, 13-migration disposable replay, native authenticated host probes. | Agent deploys to the authorized host, applies forward migrations after backup, checks HTTPS/OAuth/webhooks and verifies reboot/reconciliation. Founder supplies host/domain access and authorizes costs/deployment. See [host runbook](persistent-pilot-host.md). |
| Physical app and printing | Mobile typecheck/tests/lint/export and CI Expo Doctor; artifact validators and private HTTP tests. | Agent prepares builds and coordinates two-phone cellular/deep-link/account-switching checks. Founders operate phones and validate real printing/counter scanning. |
| Seller-funded return | [Connected return contract](connected-returns.md), UPS PDF/USPS QR SDK tests and six native preparations. | Agent tests actual provider return purchase/recovery/refund with authorization. Buyer performs physical return if required, seller confirms receipt. Seller absorbs return postage; no second buyer payment. |
| Review, merge and issue closure | Coordinated draft [server #6](https://github.com/tbd-knows/apt-server/pull/6) and [mobile #8](https://github.com/tbd-knows/apt-mobile/pull/8); Robel Bruk requested. | Agent records final evidence and addresses review comments. Robel Bruk reviews; a founder merges. Agent closes TBD-12 only after acceptance and both merges. |

## Execution order once prerequisites are supplied

1. Obtain the secure configuration path, two intended identities, authorized
   host/domain and confirmed economics. Check configuration presence privately;
   do not paste values into commands, logs, documentation or conversation.
2. Use the [persistent-host runbook](persistent-pilot-host.md) to prepare and
   deploy the selected test environment with the forward migrations, private
   photo bucket and two isolated gateways. Verify `host:config check` and
   `check-running`, public HTTPS, private-route denial and both model runtimes.
3. Run real-model conversations for requirements 1–4, including decline,
   corrected terms and missing-information cases. Use the real app/API flow;
   do not inject the scripted model choices from the deterministic harness.
   `test:e2e-live` proves chat/auth plumbing only, not this commerce acceptance.
4. Complete Stripe sandbox onboarding/payment/webhook/refund checks separately
   from shipping. An actual hosted shipping account may expose live rates only;
   test funds never authorize its live postage. Keep unsupported contracts as
   explicit blockers and repair only capabilities the provider actually offers.
5. Verify owner-authorized service discovery, consent, canonical private-form
   validation, rates, location, account reconnect and free reads. Fix discovered
   compatibility problems, then rerun the relevant regression suites.
6. With both founders present, test the two phones and exact approvals. Run the
   approved live sale/postage transaction, physical handoff, tracking, receipt
   and settlement reconciliation. Test agreed recovery/return cases without
   inventing carrier facts or introducing unapproved charges.
7. Verify host restart/reboot and app reconnection while durable work is pending.
   Record actual outcome identifiers privately and sanitized gate results here.
   Resolve failed gates before final founder review, merges and issue closure.

No real-model, provider, phone or host gate above currently has a complete
acceptance record. The next executable external steps depend on supplied model/
Stripe configuration, owner service authorization and host access. The agent
owns the dependent engineering/testing; these are not reassigned to founders
merely because they are blocked on founder-controlled prerequisites.
