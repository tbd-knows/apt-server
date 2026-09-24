create table public.pilot_connections (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  research_id uuid not null references public.pilot_research(id) on delete restrict,
  mode text not null check (mode in ('test','live')),
  endpoint text not null,
  state text not null check (state in ('discovering','review','starting','authorizing','exchanging','connected','reconnect_required','failed','revoked')),
  metadata jsonb,
  binding_digest text,
  credentials text,
  state_hash text unique,
  generation uuid not null default gen_random_uuid(),
  expires_at timestamptz,
  access_expires_at timestamptz,
  inspection jsonb,
  failure text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,exchange_id,research_id,mode)
);
create index pilot_connections_exchange on public.pilot_connections(exchange_id,owner_id,mode);
create index pilot_connections_owner on public.pilot_connections(owner_id,updated_at);
create index pilot_connections_research on public.pilot_connections(research_id);
alter table public.pilot_connections enable row level security;
alter table public.pilot_connections force row level security;
revoke all on public.pilot_connections from public,anon,authenticated;
grant all on public.pilot_connections to service_role;
