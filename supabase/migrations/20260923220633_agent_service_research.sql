-- Owner-private, read-only service research. Research is never shipment evidence.
create table public.pilot_research (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('test','live')),
  kind text not null check (kind in ('nearby','capabilities','read_source')),
  input jsonb not null,
  input_hash text not null,
  state text not null default 'pending' check (state in ('pending','running','ready','failed')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  lease_id uuid,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,exchange_id,kind,input_hash)
);
create index pilot_research_exchange on public.pilot_research(exchange_id,owner_id,created_at);
create index pilot_research_pending on public.pilot_research(owner_id,updated_at)
  where state in ('pending','running');
alter table public.pilot_research enable row level security;
alter table public.pilot_research force row level security;
revoke all on public.pilot_research from public,anon,authenticated;
grant all on public.pilot_research to service_role;
