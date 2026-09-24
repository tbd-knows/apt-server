-- Owner approval is required before contacting a discovered MCP endpoint.
-- Existing owner-private research privileges and forced RLS are retained.
alter table public.pilot_research drop constraint pilot_research_kind_check;
alter table public.pilot_research add constraint pilot_research_kind_check
  check (kind in ('nearby','capabilities','read_source','inspect_mcp'));
alter table public.pilot_research drop constraint pilot_research_state_check;
alter table public.pilot_research add constraint pilot_research_state_check
  check (state in ('awaiting_approval','declined','pending','running','ready','failed'));
alter table public.pilot_research add column approved_at timestamptz;
alter table public.pilot_research add constraint pilot_research_inspection_approval
  check (kind <> 'inspect_mcp' or state in ('awaiting_approval','declined') or approved_at is not null);
create index pilot_research_inspection_pending on public.pilot_research(mode,updated_at)
  where kind='inspect_mcp' and state in ('pending','running');
