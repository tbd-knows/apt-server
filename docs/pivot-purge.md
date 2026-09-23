# Pivot purge (TBD-11): keep / remove / defer map

Recorded on 2026-09-22 for the September 22 founder pivot. Product authority: the TBD "About" and "Current Effort" Notion pages. This document is the contract handed to TBD-12.

## Baseline

| Repository | Starting SHA (audited, `main`) | Branch |
| --- | --- | --- |
| apt-server | `acfdc13d63ff44e4d9d885a1414c1b23ead41b93` | `robelbruk4/tbd-11-pivot-purge` |
| apt-mobile | `2e7a24eef6bc91a807d0a504c4132f3e0d396d8b` | `robelbruk4/tbd-11-pivot-purge` |

Baseline checks before any edit: server `npm ci && npm run typecheck && npm test (75 tests) && npm run build` passed; mobile `npm ci && npm run typecheck && npm test (31 tests) && npm run lint` passed. Both working trees were clean. Local `main` was six commits behind `origin/main` in each repo and was fast-forwarded to the audited SHAs first.

## What the foundation is now

- Sign in/out, session refresh, one private conversation per founder, streaming, stop, reconnect/resume, restart recovery, and two-user isolation work as before.
- Each founder's agent is an isolated Hermes profile (`per_profile` topology) whose model surface is: the `memory` and `session_search` toolsets, and three Apt bridge tools (`apt_search_knowledge`, `apt_remember`, `apt_update_private_artifact`).
- Per-turn instructions are a small versioned app prompt (`src/memory/prompt.ts`, version `tbd-foundation-1`) plus the owner's private Soul/USER/MEMORY text and query-relevant private knowledge. No shared release, merchant/intent documents, proposals, or skill materialization.
- The mobile app opens on chat and has one other tab, Profile (real identity + log out). There are no feed, Hunt, cart, wishlist, board, gallery, or mock-thread entry points, and the app never asks for device location.
- No purchase, payment, or shipping capability exists or is claimed.

## apt-server

### Removed

| Path | Reason |
| --- | --- |
| `src/shopping/**`, Shopping routes in `src/app.ts`, Shopping wiring in `src/server.ts`, Shopping error codes in `src/errors.ts` | Retired product |
| `src/claw/service.ts`, `compiler.ts`, `runtime.ts`, `materializer.ts`, `repository.ts`, `domain.ts`, `commerce.ts`, `browser-config.ts`, `bridge-server.ts` | Shared release compilation, browser Hunts, proposals, skill materialization, shopping bridge tools |
| `hermes-plugins/apt-hunt-browser-policy/**` and its Dockerfile copy steps | Browser Hunt policy plugin |
| `scripts/claw-db-live.ts`, `scripts/shopping-db-live.ts`, their npm scripts | Live checks for retired features |
| `test/claw.test.ts`, `commerce.test.ts`, `browser-policy-plugin.test.ts`, `shopping-*.test.ts` | Tests for retired behavior |
| `docs/claw-operations.md` | Retired operations guide |
| `ipaddr.js` dependency | Used only by Hunt URL validation |
| `HERMES_BROWSER_EXECUTABLE_PATH` config | Browser retired |
| Foreground `location` handling in `/v1/chat/messages` | Automatic merchant-Hunt location; unknown fields are now ignored, never stored |

### Kept (and where it moved)

| Component | Location |
| --- | --- |
| Supabase token validation, chat repository, ownership/idempotency/history, run manager, bounded SSE, stop, failure/restart behavior | `src/auth.ts`, `src/repository.ts`, `src/run-manager.ts`, `src/app.ts` (unchanged semantics) |
| `AgentRuntime` interface and the isolated Hermes transport | `src/agent-runtime.ts` (`clawContext` renamed `context`) |
| Owner-scoped private context: profile load, knowledge search, remember, artifact update, runtime reconciliation | `src/memory/repository.ts` (extracted from `src/claw/repository.ts`) |
| Private artifact materialization into the Hermes profile (Soul/USER/MEMORY only) | `src/memory/materializer.ts` |
| Runtime wrapper: reconcile -> compile -> materialize -> submit, with a per-profile lock | `src/memory/runtime.ts` |
| Bridge auth (HMAC profile-bound token; derivation unchanged) and the MCP bridge (3 tools) | `src/memory/bridge-auth.ts`, `src/memory/bridge-server.ts` |
| Provisioning lifecycle, disable, confirmation-gated delete | `src/admin/service.ts` |
| `grant-founder` / `revoke-founder` | Kept as documented compatibility tooling for the untouched landing admin console; not used by the runtime |
| Local phone stack, capability harness, live e2e harness | `scripts/local-phone-stack.ts` (unchanged), `scripts/hermes-capability.ts` and `scripts/e2e-live.ts` (rewritten for the reduced surface) |

### Provisioning changes (existing profiles are refreshed on the next provision)

`HermesCliProfileAdmin.configure` now: sets `platform_toolsets.api_server=[memory, session_search]`; adds `browser` and `skills` to `agent.disabled_toolsets`; sets `plugins.enabled=[]` and `skills.external_dirs=[]`; registers exactly the three bridge tools; removes `plugins/apt-hunt-browser-policy`, `apt-shared-skills`, and the `.apt-claw.json` marker from the profile directory; removes the `AGENT_BROWSER_EXECUTABLE_PATH` secret. `validate` fails if any toolset other than `memory` and `session_search` is exposed. The one-command local stack re-provisions on every start, so a local Hermes cache cannot keep the old tools alive. Retained `private.*` skill directories stay on disk as inert data; with the skills toolset disabled they are not a tool path.

### Defect fixed while verifying

Three inherited SQL statements in the private-memory repository (`remember` insert-select and two `claw_learning_events` audit inserts) used untyped parameters that PostgreSQL rejects with `42P18 could not determine data type of parameter`. They are cast explicitly now. The original unit tests mocked the pool and could not catch this; the local-database check below does.

## apt-mobile

### Removed

`src/shopping/**`, `src/data/**` (fixtures, hooks, types), `src/app/cart.tsx`, `wishlist.tsx`, `gallery.tsx`, `(tabs)/feed.tsx`, both `board/[id].tsx` routes, the mocked `apt/thread/[id].tsx`, `components/board-picker.tsx`, `board-screen.tsx`, `cart-button.tsx`, `feed-item.tsx`, `shopping-item-card.tsx`, `price.tsx`, `src/chat/location*.ts` (+ tests), the `expo-location` dependency, its `app.json` plugin and `NSLocationWhenInUseUsageDescription`, the location checks in `scripts/ios-phone.sh`, `scripts/reset-project.js` and its npm script, and unreferenced demo images (`react-logo*`, `expo-badge*`, `expo-logo`, `logo-glow`, `tutorial-web`, `tabIcons/*`).

### Kept / changed

Auth (`src/auth/**`), API client, chat client/state/SSE/scroll/Markdown utilities, the real chat screen (cart button removed), theme, fonts, native config, bundle ID `com.robelmk.apt-mobile`, the `aptmobile` scheme, OAuth redirects, EAS settings, CI, device tooling, and the design-system primitives in `src/components/ui/**`. `_layout.tsx` no longer mounts `ShoppingProvider` (a keyed fragment still remounts on user change). Tabs are `apt` (initial) and `profile`. Profile shows real identity from Supabase with an initials fallback and log out. `package-lock.json` lost only the `expo-location` entries.

## Database disposition

This is a code purge with a documented database disposition, not a live reset. All six migrations under `supabase/migrations` are unchanged, immutable, and replayable. No new migration was added. No `DROP`, truncation, project reset, or history rewrite was performed or is authorized by this issue.

| Object(s) | Disposition | Notes / dependencies |
| --- | --- | --- |
| `agent_instances`, `messages`, `agent_runs` | Keep, active | Core chat. The `claw_release_id`, `claw_release_checksum`, `claw_mode`, `claw_profile_revision`, `claw_knowledge_revision` columns on `agent_runs` are no longer written (new runs leave them null); old values remain. The FK `agent_runs.claw_release_id -> claw_releases` means `claw_releases` cannot be dropped while those rows exist. |
| `claw_user_profiles`, `claw_user_knowledge`, `claw_learning_events` | Keep, active (renamed conceptually to private memory) | Owner-scoped. `claw_user_profiles.runtime_hash` is now the app-prompt/artifact hash. Existing rows and revisions preserved. |
| `claw_user_skills` | Retired but preserved | Not read or written by the runtime. Rows have FKs to `agent_runs`. Skill execution is disabled in Hermes. |
| `claw_admins` | Retired from the app runtime but preserved | Read by the excluded landing-page admin console; `grant/revoke-founder` still maintain it. `deleteUserRecords` still clears a user's row. |
| `claw_releases`, `claw_documents`, `claw_capabilities`, `claw_learning_proposals`, RPCs `claw_clone_release`, `claw_create_release`, `claw_save_document`, `claw_save_capability`, `claw_review_proposal`, `claw_publish_release`, `claw_stable_json`, guard triggers | Retired but preserved | Used by the landing admin console (TBD-8). Referenced by `agent_runs.claw_release_id` and `claw_learning_proposals.agent_run_id`. Future decommission needs the landing repo to stop using them first. |
| `commerce_hunts` | Retired but preserved | FK from `shopping_items.source_hunt_id` (`on delete restrict`) and to `agent_runs`/`messages`. Must be decommissioned after `shopping_*`. |
| `shopping_items`, `shopping_list_entries`, `shopping_boards`, `shopping_board_items`, trigger `shopping_enforce_cart_eligibility` | Retired but preserved | No runtime reader or writer. `deleteUserRecords` still removes a user's rows in FK order. |
| RLS / grants | Keep | Every table keeps forced RLS and revoked `anon`/`authenticated` grants; only `service_role` and the private server connection can touch them. |

Future decommission order, when a founder authorizes it with a backup/retention plan: `shopping_board_items` -> `shopping_list_entries` -> `shopping_boards` -> `shopping_items` -> `commerce_hunts` -> `claw_user_skills` -> `claw_learning_proposals` -> (after the landing console is retired) `claw_documents`/`claw_capabilities` -> `claw_releases` (requires nulling `agent_runs.claw_release_id` first) -> `claw_admins`.

### Live verification that remains blocked

The Supabase project `gmefzjlrvzmfcvlrxtco` (`aptknows-auth`) was reported INACTIVE during the issue audit and was not touched by this work. The actual deployed schema and data were not verified. Before the next production deploy an operator must, from a protected checkout: confirm the project state; confirm all six migrations are applied (`supabase migration list`); confirm the row counts of the retired tables; run the security and performance advisors; then run `npm run test:e2e-live` against two provisioned founders. Do not restore or create a paid project solely for this.

## Verification performed

| Check | Result |
| --- | --- |
| apt-server `npm ci && npm run typecheck && npm test && npm run build` | Pass (51 tests in 9 files; `dist/` rebuilt from clean contains no `claw/` or `shopping/`) |
| apt-mobile `npm ci && npm run typecheck && npm test && npm run lint` | Pass (19 tests in 4 files) |
| apt-mobile `npx expo export --platform ios` | Pass (bundle produced) |
| apt-mobile `npx expo-doctor` | Fails, pre-existing: "17 packages out of date" against Expo's live SDK 57 registry. Reproduced on the untouched baseline (18 including `expo-location`). No versions were changed by this purge; CI on `main` already reports this. |
| Hermes capability harness (`npm run test:hermes-capability`) against pinned `v2026.8.19` with the mock provider | Pass; `docs/hermes-capability-results.json` regenerated. Exactly three bridge tools discovered, retired tools absent, `browser`/`skills` toolsets absent from the API server and from the model surface, isolation and stop checks unchanged. |
| Local-database check (`npm run test:local-db`) on a throwaway PostgreSQL 16 container: replay all six migrations unchanged, seed pre-pivot data (Claw release, admin, Hunt, private skill, two founders' memory), then drive the purged server | Pass: history preserved and owner-scoped; owner-scoped turn compiles only the owner's context and materializes it; idempotent send; cross-user denial; bridge tools bound to the run owner and retired tools rejected; Hermes-side memory edits reconciled and surviving to the next turn; two-user isolation; stop; fresh user's first turn creates its profile row; restart recovery; retired rows untouched. |
| Retired public routes and the old bridge route return `404`; the bridge accepts only the three tools | Covered by `test/app.test.ts` and the live e2e script |
| Observation | Post-run private-memory reconciliation runs after the terminal SSE event; a server shutdown in that window logs "Private memory reconciliation failed" and the artifacts are reconciled from disk on the owner's next turn instead. Pre-existing behavior, unchanged. |
| Device/live-provider test | Not run. No iPhone, live Hermes provider, or active Supabase project was used. |

## Contract for TBD-12

- Server entry: `src/server.ts` builds `MemoryAgentRuntime(HermesAgentRuntime, MemoryService, MemoryMaterializer)` and `buildApp({ config, repository, auth, runtime, memoryService })`.
- Run context is `{ userId, runId, requestMessageId }` (`src/memory/domain.ts`); it is created by `RunManager.begin` and is the only identity a tool ever sees.
- Adding an agent tool means: add its name to `MEMORY_TOOL_NAMES`, its schema and handler to `MemoryService.invoke`, its registration to `src/memory/bridge-server.ts`, and re-provision (the harness and provisioning validation assert the exact tool list).
- Two isolated agent contexts can communicate only through this server. There is no agent-to-agent transport yet; TBD-12 adds it, plus payment and shipping providers, as new narrow modules and new forward migrations.
- TBD-10 (API URL reachable off the LAN) is still open and is carried forward unchanged.
