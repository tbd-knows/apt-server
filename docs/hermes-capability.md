# Hermes capability result

Tested release: `v2026.8.19` / Hermes Agent `0.20.5`.

## Topology decision (Phase 0, August 2026; still binding)

The shared multiplex listener was rejected for the pilot. API-server bearer keys, session stores, and profile SQLite databases were isolated, but live custom-provider requests for profile B used profile A's `MOCK_PROVIDER_KEY`. This crosses a required provider-credential boundary even though transcript rows remained profile-scoped. Shared multiplexing also does not expose the Apt MCP registration as a profile-bound API-server toolset.

Therefore production must set `HERMES_TOPOLOGY=per_profile`: one Hermes process/container per profile. Do not re-enable shared multiplexing as a simplification.

## Per-profile evidence retained from Phase 0

- sequential and concurrent turns with intentionally identical session UUIDs;
- distinct provider credentials and no cross-profile prompt context;
- separate session APIs, histories, and `state.db` files;
- clean restart with isolation retained;
- wrong-key and cross-profile-key denial;
- terminal, filesystem, code execution, delegation, cron, and arbitrary MCP servers absent;
- run stop settling as cancelled.

## Reduced tool surface after the TBD-11 purge (September 2026)

The pivot removed browser Hunts, shared skills, and the five shopping/commerce bridge tools. The harness now asserts, per profile and after restart:

- exactly the three Apt bridge tools (`apt_search_knowledge`, `apt_remember`, `apt_update_private_artifact`) are discoverable through `hermes mcp test apt`, and none of the retired tools (`apt_propose_shared_change`, `apt_previous_hunts`, `apt_commerce_hunt`, `apt_get_shopping_state`, `apt_manage_shopping`) are;
- only the `memory` and `session_search` toolsets are enabled on the API server; `browser` and `skills` are disabled;
- no `browser_*` tool, `web_search`, `skills_list`/`skill_view`/`skill_manage`, or dangerous tool reaches the model surface, while a retained `private.*` skill directory is still present on disk as inert data;
- Hermes' constrained `tool_search`/`tool_describe`/`tool_call` discovery path is still present.

Browser-specific checks from Phase 0 (the observed-link resolver, the 45-second cold-command allowance, the external headless-browser interaction, and the browser policy plugin) were retired with the feature and are no longer asserted.

Re-run `npm run test:hermes-capability` before any Hermes upgrade or topology change. [The JSON result](hermes-capability-results.json) is the machine-readable audit artifact; the harness uses no production model credentials or user data.

The local Python runtime emitted Hermes' SQLite `3.51.2` WAL-reset warning and correctly fell back to `journal_mode=DELETE`. The pinned container uses Python `3.12`; operators should still re-run `hermes doctor` when the upstream image/runtime is refreshed.
