# Persistent two-founder pilot host

This is the supported single-host deployment plan for TBD-12. One Linux host
with systemd runs the API/commerce worker and two Hermes gateways as independent
services. Phones connect over HTTPS and may disconnect without stopping payment
reconciliation, A2A delivery, research, tracking or saved conversations. Supabase
remains the durable database/Auth/storage service. This is deployment engineering,
not evidence that a live host or a complete provider transaction has been tested.

Use the same reviewed server commit, Node 22, Python 3.12 and pinned Hermes
`v2026.8.19` for provisioning and normal operation. Do not use the illustrative
Docker Compose file for this deployment: its separate containers do not yet
provide a shared memory materializer/Node MCP runtime. No new shipping-provider
platform credentials are required by this host.

## Fixed layout and private listeners

| Path or listener | Purpose |
| --- | --- |
| `/opt/tbd/app` | Reviewed server checkout, compiled `dist`, dependencies and `hermes-plugins` |
| `/opt/tbd/node/bin/node` | Node 22 executable; also recorded in provisioned MCP configuration |
| `/opt/tbd/hermes` | Python 3.12 virtualenv and pinned editable Hermes source checkout |
| `/var/lib/tbd/hermes` | Persistent profile configs, private memory, sessions, plugins and per-profile secrets |
| `/etc/tbd/server.env` | Server configuration and platform credentials; `root:tbd`, mode 0640 |
| `/etc/tbd/routing.env` | Generated nonsecret API/A2A maps read by Node |
| `/etc/tbd/founder1.env`, `founder2.env` | Generated nonsecret routing for each Hermes service |
| `127.0.0.1:8787` | Fastify and its private MCP/A2A bridges |
| `127.0.0.1:8642`, `8643` | Founder Hermes APIs |
| `127.0.0.1:9900`, `9901` | Hermes native A2A listeners |

Only Caddy's ports 80/443 are public (plus operator-restricted SSH). Keep all
five application listeners on loopback. Caddy forwards the documented public
API, Stripe webhook and OAuth callback/client-metadata routes; everything else
returns 404. There is no public Hermes or `/internal` route. SSE responses are
flushed without proxy buffering. Caddy manages HTTPS for the selected DNS name.

## Prepare a reviewed installation

The operator supplies a Linux host, a DNS name pointing to it, the two founder
Auth IDs, model access and Stripe setup. Use test mode and the intended test
database for the first provider walkthrough. Preserve `HERMES_KEY_SECRET` across
restarts: it binds profile identity, bridge/peer authentication and saved OAuth
credentials. Rotating it is a coordinated credential migration, not a restart.

1. Create an unprivileged `tbd` system user/group with home `/var/lib/tbd`.
   Install Node 22 at `/opt/tbd/node`, Python 3.12, git, CA certificates and Caddy.
   Install the reviewed server checkout at `/opt/tbd/app`, then run `npm ci` and
   `npm run build` with that Node on `PATH`. Keep the app and executable trees
   root-owned/read-only to the running services. Provision from compiled code;
   do not record a temporary checkout or a developer laptop's Node path.
2. Prepare the pinned Hermes runtime (installation commands, not service startup):

   ```sh
   python3.12 -m venv /opt/tbd/hermes
   git clone --depth 1 --branch v2026.8.19 --single-branch https://github.com/NousResearch/hermes-agent.git /opt/tbd/hermes/source
   /opt/tbd/hermes/bin/python -m pip install --editable '/opt/tbd/hermes/source[mcp]' 'aiohttp>=3.9,<4' 'ddgs==9.16.0'
   /opt/tbd/hermes/bin/hermes --version
   ```

   The MCP extra is required by the Apt bridge; editable installation preserves
   Hermes's checkout-relative files. `ddgs` provides the existing keyless public
   research path. This does not configure any new commerce-provider account.
3. Create `/var/lib/tbd/hermes` owned by `tbd:tbd`, mode 0700, and `/etc/tbd`
   owned by `root:tbd`, mode 0750. Copy `.env.example` into the protected
   `/etc/tbd/server.env`, fill the existing application secrets and use:

   ```dotenv
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=8787
   HERMES_HOME=/var/lib/tbd/hermes
   HERMES_CLI=/opt/tbd/hermes/bin/hermes
   HERMES_TOPOLOGY=per_profile
   HERMES_VERSION=v2026.8.19
   APT_INTERNAL_URL=http://127.0.0.1:8787
   APT_INTERNAL_PEER_IPS=
   APT_PUBLIC_URL=https://your-pilot-api-domain.example
   APT_COMMERCE_MODE=test
   APT_LIVE_COMMERCE_ENABLED=false
   ```

   Keep `server.env` mode 0640 and owned by `root:tbd`. Hermes service units
   receive only their routing file and load their own profile `.env`; they do
   not inherit Stripe, Supabase or root-secret variables from the server.
4. Review and apply all 12 repository migrations through the project's normal
   migration process against the chosen database. Back up before upgrading.
   `npm run test:local-db` is destructive and belongs only on the disposable
   local test database; it is never a deployment/migration command.
5. Generate configuration into a **new** staging directory (the renderer refuses
   to overwrite an existing directory). It makes no database or provider calls:

   ```sh
   sudo -u tbd /opt/tbd/node/bin/node --env-file=/etc/tbd/server.env /opt/tbd/app/dist/admin/pilot-host.js render /var/lib/tbd/host-config
   sudo install -o root -g tbd -m 0640 /var/lib/tbd/host-config/routing.env /etc/tbd/routing.env
   sudo install -o root -g tbd -m 0640 /var/lib/tbd/host-config/founder1.env /etc/tbd/founder1.env
   sudo install -o root -g tbd -m 0640 /var/lib/tbd/host-config/founder2.env /etc/tbd/founder2.env
   sudo install -m 0644 /opt/tbd/app/deploy/tbd-pilot.target /etc/systemd/system/tbd-pilot.target
   sudo install -m 0644 /opt/tbd/app/deploy/tbd-server.service /etc/systemd/system/tbd-server.service
   sudo install -m 0644 /opt/tbd/app/deploy/tbd-hermes@.service /etc/systemd/system/tbd-hermes@.service
   sudo systemd-analyze verify /etc/systemd/system/tbd-pilot.target /etc/systemd/system/tbd-server.service /etc/systemd/system/tbd-hermes@founder1.service /etc/systemd/system/tbd-hermes@founder2.service
   sudo systemctl daemon-reload
   ```

## Provision once, then enable persistent operation

Initial provisioning needs the private Apt bridge, so start only the server
first: `sudo systemctl start tbd-server`. Its health is expected to be degraded
until the gateways exist. The worker is active at this point; use the selected
test environment, not an accidental live database. Do not expose Caddy yet.

Run the following command once per actual founder UUID, substituting the UUID:

```sh
sudo -u tbd env HOME=/var/lib/tbd PATH=/opt/tbd/node/bin:/opt/tbd/hermes/bin:/usr/local/bin:/usr/bin:/bin /opt/tbd/node/bin/node --env-file=/etc/tbd/server.env --env-file=/etc/tbd/routing.env /opt/tbd/app/dist/admin/provision-user.js --user-id FOUNDER_UUID
```

Provisioning configures the isolated tools, installs the A2A/research plugin,
checks the MCP bridge and performs a real model validation turn. It requires
model access and may incur model usage. The host renderer never creates users,
changes founder grants or calls a provider. Claw founder administration remains
the separate `grant-founder` command when required by the pilot runbook.

Then check the installation and start both gateways:

```sh
sudo -u tbd /opt/tbd/node/bin/node --env-file=/etc/tbd/server.env --env-file=/etc/tbd/routing.env /opt/tbd/app/dist/admin/pilot-host.js check
sudo systemctl enable --now tbd-pilot.target
sudo -u tbd /opt/tbd/node/bin/node --env-file=/etc/tbd/server.env --env-file=/etc/tbd/routing.env /opt/tbd/app/dist/admin/pilot-host.js check-running
```

Allow initial gateway startup to finish before `check-running`. The read-only
check verifies both database identities, private profile credentials, the
pinned Hermes release, compiled MCP bridge, exact routing and authenticated
discovery on **both** APIs and **both** A2A endpoints. It then verifies API/DB
health. It does not submit model turns, A2A messages, labels or payments.

Validate the generated Caddyfile before installing it:

```sh
sudo caddy validate --config /var/lib/tbd/host-config/Caddyfile --adapter caddyfile
sudo install -m 0644 /var/lib/tbd/host-config/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Set the mobile build's `EXPO_PUBLIC_APT_API_URL` to the same HTTPS origin and
configure Stripe's signed webhook at `/webhooks/stripe`. Check `/health` remotely,
and confirm `/internal`, `/internal/a2a/outbox`, `/v1/runs` without app auth and
`/.well-known/agent-card.json` cannot expose an agent. `/v1/runs` is not an app
route and must return 404. Actual account OAuth and Stripe tests remain separate
acceptance checks, including Link, seller onboarding and webhook delivery.

## Restart, upgrade and recovery

- `systemctl restart tbd-pilot.target` restarts all three services. Each service
  also restarts after an unexpected exit, without requiring an active phone.
  The API worker stays available while a single gateway restarts. The API health
  endpoint reports degraded if either mapped gateway is unavailable.
- `systemctl stop tbd-pilot.target` stops all three; process-group cleanup includes
  Hermes's MCP subprocesses. Graceful shutdown is given 45 seconds. Inspect
  `systemctl status tbd-server tbd-hermes@founder1 tbd-hermes@founder2` and the
  corresponding journal when a check fails. Do not paste tokens or raw private
  profile logs into an issue.
- For a reviewed upgrade, stop the target, back up the database and persistent
  profile directory, replace/build the app at its stable path, apply reviewed
  forward migrations, and reprovision each profile after starting only the
  server if tools/config/plugins changed. Stop the server before replacing code.
  Run the checks again and restart the target. Retain the previous app release
  for rollback; never blindly downgrade a migrated database.
- Back up `/var/lib/tbd/hermes`, `/etc/tbd/server.env` and the Supabase database
  through protected storage. Restore the matching root secret and the same
  founder IDs before starting. Do not delete uncertain commerce operations or
  replay purchases to repair a restart: the existing durable worker reconciles
  provider identities and fails closed when it cannot establish the outcome.
- Host acceptance still requires a real reboot, both phones reconnecting to
  saved sessions, two-way A2A after the reboot, payment webhook redelivery and
  a persisted in-flight operation recovering without duplicate spend. Local
  configuration/unit checks do not stand in for those host/provider tests.

References: [systemd service semantics](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml),
[Caddy reverse proxy and streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[Hermes native A2A](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a).
