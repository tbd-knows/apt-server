# Two-founder pilot on Render

Render replaces the manually operated Linux host; it does not replace the
seller's shipping account. Use one paid Docker web service with one persistent
disk. The API/worker and two isolated Hermes gateways share the disk-backed
private profile tree while retaining separate profile credentials. Supabase
remains the existing Auth/database/photo service.

The checked-in `render.yaml` proposes one Standard instance and a 10 GB disk,
with automatic deploys off. Review the current Render price and approve creation
before provisioning billable resources. No Render service has been created by
these code changes. A Render `onrender.com` HTTPS origin is sufficient for the
initial pilot; buying a custom domain is optional.

## Configuration

Local development reads the ignored `apt-server/.env`. Keep it mode0600 and
fill the existing `.env.example` fields. Credentials are never committed. For
Render, enter values in the service Environment settings; Render also supports
importing `.env` values. Do not import local filesystem paths or local public
URLs. The container sets the fixed private routing itself.

Required values include the retained Supabase application settings, exactly two
founder Auth UUIDs, the existing stable `HERMES_KEY_SECRET`, `HERMES_MODEL`,
`HERMES_PROVIDER_API_KEY`, Stripe platform/account mappings/webhook secret, public
HTTPS origin, and confirmed tax/fee economics. The Blueprint prompts for secrets
without embedding them. Configure additional model-provider fields from
`.env.example`/`src/config.ts` if using a provider other than the default.

Do not regenerate the root secret for existing users: it binds their identities,
private bridge/A2A credentials and encrypted shipping connections. Start with
test Stripe and `APT_COMMERCE_MODE=test`; live commerce requires the separate
explicit enable flag. A test payment cannot buy live hosted-service postage.

## First deployment

1. Connect the Render workspace to the server repository and review the
   Blueprint's paid plan, disk and selected PR branch/commit. Keep automatic
   deploys off while the coordinated PRs are Draft.
2. Review/back up and apply all 13 forward migrations to the selected database
   through the existing migration process; create the private photo bucket.
   Neither the entrypoint nor the Blueprint runs migrations or grants founders.
   Never run `test:local-db` on this database.
3. Enter the protected configuration, including the actual Render HTTPS origin
   as `APT_PUBLIC_URL`. Configure Stripe's signed endpoint at
   `/webhooks/stripe`; use the same origin for the mobile API. The proxy exposes
   the app API, health, commerce return and service OAuth callback/client
   metadata only. Both Hermes APIs/A2A and the internal bridge stay on loopback.
4. For first provisioning or an explicitly requested repair, set
   `APT_RENDER_PROVISION=true` before deploying. This runs the existing
   provisioning command for the two configured Auth users, including real model
   validation; it can incur model usage. Existing deterministic identities and
   private history are preserved. It never creates additional Auth users.
5. After successful provisioning, set `APT_RENDER_PROVISION=false` and redeploy.
   Leaving it true repeats provisioning/model validation on every restart.
   Normal startup verifies persisted profile identity, private secrets, pinned
   Hermes version, both authenticated runtimes and server health before opening
   the public port. Missing profiles/configuration fail visibly.
6. Complete [the acceptance register](pilot-acceptance.md), including actual
   model/provider/phone behavior. Owners authorize their discovered shipping
   service through the app's OAuth/MCP flow. Render is not a shipping provider.

The service runs unprivileged after initializing ownership of the mounted disk's
top-level directory. API and provisioning processes hold platform credentials;
Hermes subprocesses receive only basic process settings and their own private
profile environment. Provisioning CLI and validation subprocesses use the same
filtered environment. A child failure stops the entire instance so Render can
restart a consistent three-process stack. SIGTERM gives children up to45seconds
before group termination; Render's configured shutdown window is60seconds.

## Evidence and limits

Local tests cover secret filtering, public/private path classification, streaming
request/response transport and port collisions. CI's `render-container` job builds
the exact combined image, exercises supervisor startup/shutdown and gateway-loss
with synthetic children, and runs the existing native15-preparation Hermes
commerce suite inside that image with real disposable PostgreSQL and synthetic
model/providers. The production image excludes those fixture files and dev tools.
These checks do not establish a deployed Render service, a successful real model
provisioning turn, sufficient production memory, a mounted Render disk surviving
redeploy, or real Stripe/shipping/phone acceptance.

Render disks are runtime-only and attached to one instance. They cannot be
shared across separate Render services or accessed in pre-deploy/one-off jobs.
Do profile provisioning at service startup as above. Disk-backed redeploys have
brief downtime; verify recovery with pending operations without duplicate spend.
No autoscaling or second instance is supported for this pilot.

References checked September26,2026:
[Render disks](https://render.com/docs/disks),
[web services](https://render.com/docs/web-services),
[environment variables](https://render.com/docs/configure-environment-variables),
[Blueprint configuration](https://render.com/docs/blueprint-spec),
[shutdown behavior](https://render.com/docs/deploys).
