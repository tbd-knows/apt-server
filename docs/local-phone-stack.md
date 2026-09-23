# One-command physical-iPhone stack

The local launcher turns the two sibling repositories into one supervised development stack:

1. validates the protected server environment;
2. discovers every `ready` beta mapping in Supabase, or uses explicit user IDs;
3. installs the pinned Hermes release into `.local/` when `hermes` is not already available;
4. idempotently recreates missing local Hermes profiles and validates a real provider turn;
5. assigns one loopback gateway port per opaque profile;
6. starts every Hermes gateway and waits for health;
7. starts Apt Server with the generated profile-to-URL map and waits for database/Hermes health;
8. validates `APT_MOBILE_API_URL` when supplied, otherwise detects the Mac's LAN IPv4 address, and atomically updates apt-mobile's ignored `.env.local` with the API URL and public Supabase values;
9. builds, signs, installs, and launches apt-mobile on the connected iPhone, then starts Metro;
10. stops the mobile process, Apt Server, and every Hermes gateway when the operator presses `Ctrl-C`.

## One-time setup on a new Mac

- Clone `apt-server` and `apt-mobile` beside each other. Set `APT_SERVER_DIR` or `APT_MOBILE_DIR` if they live elsewhere.
- Install Xcode, accept its license, enable Developer Mode on the iPhone, and install Node.js 22 LTS and Python 3.12.
- Copy `.env.example` to `apt-server/.env` and receive the real development values through the team password manager. The exact shared `HERMES_KEY_SECRET` is required because it deterministically binds existing Supabase mappings to Hermes profile/session identities.
- Never put the service-role key, database URL, provider key, or Hermes key secret in apt-mobile. The launcher copies only the public Supabase URL/key and the LAN API URL to the ignored `apt-mobile/.env.local`.
- Keep the Mac and iPhone on the same Wi-Fi. USB-C handles Xcode discovery, signing, installation, and launch; the development API and LAN-mode Metro still use the local network.

The normal entry point is from apt-mobile:

```bash
npm run ios:stack
```

The wrapper installs missing apt-server npm dependencies before starting the stack. The existing `ios:phone` script installs missing apt-mobile dependencies and CocoaPods when necessary.

## User selection

With no flags or `APT_LOCAL_USER_IDS`, the launcher queries the shared database and starts every `ready` beta profile. This is the easiest review path and currently starts both beta users.

To limit a run to one or more accounts:

```bash
npm run ios:stack -- --user-id <supabase-user-uuid>
npm run ios:stack -- --user-id <uuid-a> --user-id <uuid-b>
```

For a persistent local selection, set a comma-separated value only in ignored `apt-server/.env`:

```dotenv
APT_LOCAL_USER_IDS=<uuid-a>,<uuid-b>
```

The command is safe to rerun. Provisioning re-applies the exact narrow tool/MCP policy, removes legacy non-private skill directories, validates the profile, and preserves its private artifacts; if a profile is absent on a new Mac, it is created and validated before the stack starts.

## Useful overrides

```dotenv
APT_LOCAL_HERMES_BASE_PORT=8642
APT_LOCAL_LAN_IP=192.168.1.20
APT_MOBILE_DIR=../apt-mobile
```

From apt-mobile, `APT_SERVER_DIR` may point the wrapper at a non-sibling server checkout. `APT_METRO_MODE=tunnel` may be supplied for Metro, but Apt Server must still be reachable at the generated or overridden API address.

## Failure behavior

- Missing/placeholder secrets fail before any long-running process starts.
- A missing Hermes CLI triggers a pinned repo-local installation; an explicitly configured missing CLI or wrong Hermes version fails closed.
- Occupied Hermes, server, or Metro ports fail with the exact port rather than accepting an Expo fallback prompt.
- If a gateway, Apt Server, or the mobile process exits unexpectedly, the supervisor terminates the rest of the stack.
- `.local/`, `.env`, and apt-mobile `.env.local` are ignored. Provider and server secrets are never printed or copied into the mobile repository.

To stop normally, press `Ctrl-C` once in the stack terminal and wait for `Stopping local Apt stack...`.

## Off-LAN API and webhook reachability (TBD-10)

Set `APT_MOBILE_API_URL=https://api.example.com` in the protected server environment. It must be an absolute HTTP(S) origin with no credentials, path, query or fragment. Public origins require HTTPS; private LAN/loopback HTTP remains available for development. The launcher checks its `/health` before copying it to `EXPO_PUBLIC_APT_API_URL`; a bad override fails instead of silently falling back to LAN.

A Metro tunnel serves JavaScript only. Independently supervise the Fastify HTTPS endpoint through a persistent host/reverse proxy or a stable tunnel forwarding local port 8787. Keep it available for payment and shipment webhook delivery after the phone disconnects. Set `APT_PUBLIC_URL` to the same stable HTTPS origin for hosted provider return URLs.

Expose `/health`, `/v1/*`, `/webhooks/stripe`, `/webhooks/easypost` and `/commerce/return` only. Explicitly deny `/internal/*` at the proxy/tunnel. Preserve forwarded headers so the server also rejects forwarded bridge requests. Do not expose Hermes ports. The bridge permits loopback peers by default; Docker requires the exact private Hermes container IPs in `APT_INTERNAL_PEER_IPS` and `APT_INTERNAL_URL=http://apt-server:8787` during provisioning. The compose example provides fixed private IPs.

Acceptance still needs both physical phones on cellular to authenticate, open actions/chat and receive a provider webhook through that endpoint. This check has not been performed without configured accounts/credentials.
