FROM python:3.12.11-slim-bookworm
ARG HERMES_REF=v2026.8.19
RUN apt-get update \
    && apt-get install --yes --no-install-recommends git ca-certificates \
    && git clone --depth 1 --branch "$HERMES_REF" https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
    && python -m pip install --no-cache-dir /opt/hermes-agent 'aiohttp>=3.9,<4' 'ddgs==9.16.0' \
    && apt-get purge --yes --auto-remove git \
    && rm -rf /var/lib/apt/lists/*
ENV HERMES_HOME=/var/lib/hermes
VOLUME ["/var/lib/hermes"]
EXPOSE 8642
ENTRYPOINT ["hermes"]
CMD ["gateway", "run", "--force", "--external-supervisor", "--accept-hooks"]
