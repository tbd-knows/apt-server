create table public.pilot_service_actions (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  connection_id uuid not null references public.pilot_connections(id) on delete restrict,
  mode text not null check(mode in ('test','live')),
  turn_id uuid not null,
  revision integer not null,
  generation uuid not null,
  endpoint text not null,
  invocation jsonb not null,
  explanation text not null,
  digest text not null,
  call_digest text not null,
  state text not null check(state in ('review','declined','verifying','running','returned','returned_error','failed','uncertain','expired')),
  result jsonb,
  approved_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id,turn_id)
);
create index pilot_service_actions_exchange on public.pilot_service_actions(exchange_id,owner_id,mode,created_at);
create index pilot_service_actions_connection on public.pilot_service_actions(connection_id,call_digest);
create index pilot_service_actions_pending on public.pilot_service_actions(mode,updated_at) where state in ('verifying','running','review');
alter table public.pilot_service_actions enable row level security;
alter table public.pilot_service_actions force row level security;
revoke all on public.pilot_service_actions from public,anon,authenticated;
grant all on public.pilot_service_actions to service_role;
