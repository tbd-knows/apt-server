FROM node:22.23.2-bookworm-slim AS build
WORKDIR /opt/tbd/app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
RUN apt-get update && apt-get install --yes --no-install-recommends git ca-certificates libatomic1 gosu \
    && test -x /usr/sbin/gosu \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /opt/tbd/hermes \
    && git clone --depth 1 --branch v2026.8.19 --single-branch https://github.com/NousResearch/hermes-agent.git /opt/tbd/hermes/source \
    && test "$(git -C /opt/tbd/hermes/source rev-parse HEAD)" = fcbd1076a93841fa88855acce810e342a5b78101 \
    && /opt/tbd/hermes/bin/python -m pip install --no-cache-dir --editable '/opt/tbd/hermes/source[mcp]' 'aiohttp==3.14.3' 'ddgs==9.16.0' \
    && groupadd --gid 10001 tbd && useradd --uid 10001 --gid tbd --home-dir /var/lib/tbd tbd \
    && mkdir -p /var/lib/tbd /etc/tbd && chown tbd:tbd /var/lib/tbd /etc/tbd
COPY --from=build /usr/local/bin/node /opt/tbd/node/bin/node
ENV PATH=/opt/tbd/node/bin:/opt/tbd/hermes/bin:/usr/local/bin:/usr/bin:/bin \
    HOME=/var/lib/tbd NODE_ENV=production
WORKDIR /opt/tbd/app
COPY --from=build /opt/tbd/app/ ./
COPY hermes-plugins ./hermes-plugins
# npm is needed only to prune build dependencies, never by running agents.
COPY --from=build /usr/local/lib/node_modules/npm /opt/tbd/npm
RUN node /opt/tbd/npm/bin/npm-cli.js prune --omit=dev && rm -rf /opt/tbd/npm
COPY deploy/render-entrypoint.sh /usr/local/bin/tbd-render-entrypoint
RUN chmod 755 /usr/local/bin/tbd-render-entrypoint
ENTRYPOINT ["/usr/local/bin/tbd-render-entrypoint"]
EXPOSE 10000
CMD ["/opt/tbd/node/bin/node", "dist/admin/render-host.js"]

# CI-only image: production runtime plus existing disposable native test files.
FROM runtime AS verification
COPY --from=build /opt/tbd/app/node_modules ./node_modules
COPY scripts ./scripts
COPY test ./test
COPY supabase/migrations ./supabase/migrations
COPY --chown=tbd:tbd docs ./docs
CMD ["/bin/sh", "-c", "node --import tsx scripts/local-db-check.ts && node --import tsx scripts/hermes-a2a-check.ts"]

# Keep the deploy target last: development tools and fixtures are excluded.
FROM runtime AS production
