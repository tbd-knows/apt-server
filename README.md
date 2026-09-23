# Apt server

Private chat backend for the TBD two-founder pilot. The mobile app authenticates with Supabase, this service owns all transcript writes, and each founder is mapped to one manually provisioned, process-isolated Hermes profile and stable session.

This is the foundation left by the September 2026 pivot purge (Linear TBD-11). It provides authenticated private chat with owner-scoped memory and nothing else: no merchant research, browser automation, Shopping, Feed, Boards, or shared prompt releases, and no purchase, payment, or shipping capability yet. See [docs/pivot-purge.md](docs/pivot-purge.md) for the keep/remove/defer map and the database disposition.

## Runtime contract

- Node.js `22`, strict TypeScript, Fastify, PostgreSQL, and Hermes Agent `v2026.8.19` (`0.20.5`).
- Supabase Auth access tokens are required on every `/v1/chat/*` route. A `401` never falls back to an anonymous identity.
- Mobile clients cannot read or write the chat tables directly. RLS is forced, `anon`/`authenticated` grants are revoked, and only the private server database connection mutates transcripts.
- There is one user-visible thread, one active run per user, and one stable Hermes session per user.
- Before each Runs API submission, the server compiles a small versioned app prompt (`src/memory/prompt.ts`) with that user's private Soul/USER/MEMORY artifacts, relevant private knowledge, and whole recent messages bounded to 48,000 characters. Nothing is read from a shared release table.
- The Hermes topology is `per_profile`; see [the capability result](docs/hermes-capability.md). Shared multiplexing crosses the provider-credential boundary and must not be re-enabled.
- Hermes profiles contain no bundled skills and no plugins. They expose only the `memory` and `session_search` toolsets plus the three typed Apt bridge tools (`apt_search_knowledge`, `apt_remember`, `apt_update_private_artifact`). Browser, skills, web, terminal, filesystem, code execution, delegation, and cron toolsets are disabled in profile configuration and rejected by provisioning validation.

## Development

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

`GET /health` is unauthenticated and returns `503` when PostgreSQL or Hermes is unavailable. It never includes credentials or user data.

### One-command physical iPhone stack

With `apt-server` and `apt-mobile` checked out beside each other and the protected server `.env` configured, connect an unlocked iPhone over USB-C and run this from apt-mobile:

```bash
npm run ios:stack
```

The launcher discovers ready beta mappings, bootstraps pinned Hermes when needed, provisions or re-provisions local profiles (which also strips the retired browser plugin, shared-skill mount, and Claw marker from existing profiles), starts all per-profile gateways and Apt Server, writes only public/LAN values to the mobile's ignored `.env.local`, then builds, installs, launches, and serves the app. `Ctrl-C` shuts down the complete stack. See [the local phone stack guide](docs/local-phone-stack.md) for new-Mac setup, user selection, networking, and failure behavior.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Bounded database and Hermes readiness |
| `GET` | `/v1/chat?before=<sequence>&limit=50` | Read chronological history and the active run |
| `POST` | `/v1/chat/messages` | Idempotently append a user turn, reserve an assistant message, and create a run |
| `GET` | `/v1/chat/runs/:runId` | Read the authenticated user's run snapshot |
| `GET` | `/v1/chat/runs/:runId/events` | Sanitized SSE: snapshot, assistant delta, and terminal events only |
| `POST` | `/v1/chat/runs/:runId/stop` | Mark stopping and interrupt Hermes when a Hermes run exists |

Message bodies are `{ "clientMessageId": "<uuid>", "content": "..." }`. Content is normalized and limited to 8,000 characters. Unknown fields are ignored, never stored. Reusing the same client message ID for the same user returns the original turn; a second active turn returns `RUN_IN_PROGRESS`.

`POST /internal/agent/tool` is the loopback bridge that a user's own Hermes profile calls with a profile-bound HMAC token. It accepts only the three private-context tools and binds every call to the run that is active for that profile, so tool arguments can never select another user.

Stable error response:

```json
{ "error": { "code": "AGENT_NOT_PROVISIONED", "message": "Apt chat has not been provisioned for this user." } }
```

## Database

Migrations live under `supabase/migrations`. All six are immutable and replayable; none was rewritten by the purge. The active runtime uses:

- `agent_instances`: Supabase user to opaque Hermes profile/session mapping.
- `messages`: keyset-ordered user and assistant transcript with same-owner reply constraints.
- `agent_runs`: request/response ownership constraints and a partial unique index permitting only one active run per user. The `claw_*` columns on this table are no longer written.
- `claw_user_profiles`, `claw_user_knowledge`, `claw_learning_events`: owner-scoped private Soul/USER/MEMORY text, full-text-searchable knowledge, and the learning audit trail. The table names are historical; the data is the founders' private memory and is preserved.

The `claw_releases`/`claw_documents`/`claw_capabilities`/`claw_admins`/`claw_learning_proposals`/`claw_user_skills`, `commerce_hunts`, and `shopping_*` objects remain in the schema but are not read or written by this server. Their disposition is recorded in [docs/pivot-purge.md](docs/pivot-purge.md). Do not drop them as part of a code change.

On startup, queued/running/stopping rows are failed with `SERVER_RESTARTED`; Hermes is stopped best-effort and no prompt is replayed.

## Manual beta lifecycle

Provisioning is deliberately operator-only and idempotent. It validates the Supabase user, derives opaque stable identifiers, creates or reconfigures a Hermes profile without bundled skills, applies the narrow toolset policy and profile-bound Apt bridge, removes retired plugin/skill/marker files and secrets from existing profiles, writes secrets with mode `0600`, runs Hermes config/MCP/live-turn validation (which fails if any toolset other than `memory` and `session_search` is exposed), then upserts the mapping.

```bash
npm run provision-user -- --user-id <supabase-user-uuid>
npm run disable-user -- --user-id <supabase-user-uuid>
npm run delete-user -- --user-id <supabase-user-uuid> --confirm <same-supabase-user-uuid>
```

Deletion removes the Hermes profile before database records, including rows in the retired-but-preserved tables. A failure leaves database ownership records intact so an operator can retry safely.

`grant-founder` and `revoke-founder` remain as compatibility tooling for the landing-page admin console, which is outside this repository and still reads `claw_admins`. The app runtime does not use them.

After provisioning, start exactly one pinned Hermes process/container for that profile. Name it `hermes-<opaque-profile-name>` on the backend network so `HERMES_PROFILE_URL_TEMPLATE=http://hermes-{profile}:8642` resolves it. Never expose port `8642` publicly. Repeat the example service in [docker-compose.example.yml](docker-compose.example.yml) once per profile; there is no runtime provisioner.

For local host processes on distinct ports, set `HERMES_PROFILE_URL_MAP` to a JSON object such as `{"apt-opaque-a":"http://127.0.0.1:8642","apt-opaque-b":"http://127.0.0.1:8643"}`. Explicit map entries take precedence over the container-name template.

`HERMES_PROVIDER=openai-api` selects OpenAI directly. If `HERMES_PROVIDER=custom`, `HERMES_PROVIDER_BASE_URL` is required so Hermes cannot silently route the credential through its default aggregator.

## Verification

```bash
HERMES_CLI=/path/to/hermes HERMES_VERSION=v2026.8.19 npm run test:hermes-capability
```

The harness creates two fresh profiles and a deterministic OpenAI-compatible provider, then verifies sequential/concurrent turns, provider context and credential separation, session/history/state isolation, restart isolation, cross-key denial, exact three-tool Apt bridge discovery, absence of the retired bridge tools, absence of the browser and skills toolsets and of every dangerous tool from the model surface, and stop behavior. It writes [the audit result](docs/hermes-capability-results.json).

Against a disposable local PostgreSQL (loopback only; the script drops the public schema), the upgrade-shaped fixture check replays all six migrations unchanged, seeds pre-pivot data in the retired tables, and drives the server through a fake Hermes runtime to verify owner-scoped memory, bridge-tool binding, two-user isolation, stop, restart recovery, and that retired rows are untouched:

```bash
docker run -d --name tbd-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:55432:5432 postgres:16-alpine
npm run test:local-db -- --database-url postgresql://postgres:pw@127.0.0.1:55432/postgres
```

With Apt Server and two provisioned per-profile gateways already running, the live harness creates short-lived Supabase sessions without sending email and exercises the public API against the real database and provider:

```bash
npm run test:e2e-live -- --user-a <uuid-a> --user-b <uuid-b>
```

It verifies authentication, real message/SSE completion, duplicate-send idempotency, pagination, stop, cross-user isolation, and that the retired Shopping and Claw routes return `404`. The `--write-context <marker>` and `--recall-context <marker>` modes support a deterministic continuity check across a manual Hermes restart; `--leave-running <prompt>` supports the Apt Server restart/no-replay probe.
