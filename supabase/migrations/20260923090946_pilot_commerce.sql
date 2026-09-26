-- Additive only: the six historical migrations and their data remain intact.
create table public.pilot_exchanges (
  id uuid primary key,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  seller_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('test', 'live')),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  check (buyer_id <> seller_id),
  check ((data->>'id')::uuid = id and (data->>'buyerId')::uuid = buyer_id
    and (data->>'sellerId')::uuid = seller_id and data->>'mode' = mode)
);
create index pilot_exchanges_buyer on public.pilot_exchanges(buyer_id, updated_at desc);
create index pilot_exchanges_seller on public.pilot_exchanges(seller_id, updated_at desc);

create table public.pilot_private_inputs (
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  primary key (exchange_id, owner_id)
);
create index pilot_private_inputs_owner on public.pilot_private_inputs(owner_id);

create table public.pilot_items (
  id uuid primary key,
  seller_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('test', 'live')),
  details jsonb not null,
  reserved_by uuid references public.pilot_exchanges(id) on delete restrict,
  reserved_until timestamptz,
  sold boolean not null default false
);
create index pilot_items_seller on public.pilot_items(seller_id);
create index pilot_items_reservation on public.pilot_items(reserved_by);

-- Both participant messages and owner-only actions are addressed explicitly.
create table public.pilot_messages (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  sender_id uuid not null references auth.users(id) on delete restrict,
  recipient_id uuid not null references auth.users(id) on delete restrict,
  kind text not null check (kind in ('request','seller_response','decline','question','answer','counteroffer','offer','status')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  agent_delivered_at timestamptz
);
create index pilot_messages_inbox on public.pilot_messages(recipient_id, created_at desc);
create index pilot_messages_exchange on public.pilot_messages(exchange_id);
create index pilot_messages_sender on public.pilot_messages(sender_id);

create table public.pilot_setup_operations (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('test','live')),
  state text not null check (state in ('pending','succeeded','failed')),
  created_at timestamptz not null default now()
);
create index pilot_setup_operations_owner on public.pilot_setup_operations(owner_id);

create table public.pilot_approvals (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  version integer not null check (version > 0),
  binding jsonb not null,
  created_at timestamptz not null default now(),
  unique (exchange_id, actor_id, version)
);
create index pilot_approvals_actor on public.pilot_approvals(actor_id);

create table public.pilot_operations (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  kind text not null check (kind in ('quote','checkout','label','refund','cancel_checkout','label_refund','payout','return_quote','return_label')),
  version integer not null,
  mode text not null check (mode in ('test','live')),
  state text not null default 'pending' check (state in ('pending','running','uncertain','succeeded','failed')),
  attempts integer not null default 0,
  provider_id text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (exchange_id, kind, version)
);
create index pilot_operations_pending on public.pilot_operations(updated_at) where state in ('pending','running','uncertain');

-- No raw provider payloads (they may contain full addresses or payment details).
create table public.pilot_events (
  id uuid primary key,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete restrict,
  kind text not null,
  evidence jsonb not null,
  provider_key text unique,
  created_at timestamptz not null default now()
);
create index pilot_events_exchange on public.pilot_events(exchange_id, created_at);
create index pilot_events_actor on public.pilot_events(actor_id);

create table public.pilot_commands (
  actor_id uuid not null references auth.users(id) on delete restrict,
  key text not null check (length(key) between 1 and 200),
  digest text not null,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (actor_id, key)
);
create index pilot_commands_exchange on public.pilot_commands(exchange_id);

create table public.pilot_assets (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete restrict,
  exchange_id uuid not null references public.pilot_exchanges(id) on delete restrict,
  kind text not null check (kind in ('photo','label','label_qr')),
  storage_path text not null unique,
  state text not null default 'pending' check (state in ('pending','ready')),
  mime text not null check (mime in ('image/jpeg','image/png','application/pdf')),
  bytes integer not null check (bytes between 1 and 5242880),
  created_at timestamptz not null default now()
);
create index pilot_assets_owner on public.pilot_assets(owner_id);
create index pilot_assets_exchange on public.pilot_assets(exchange_id);

create table public.pilot_preferences (
  owner_id uuid not null references auth.users(id) on delete restrict,
  key text not null check (length(key) between 1 and 80),
  value text not null check (length(value) <= 500),
  provenance text not null check (length(provenance) between 1 and 500),
  status text not null check (status in ('inferred','confirmed','forgotten')),
  check ((status='forgotten' and value='') or (status<>'forgotten' and length(value)>0)),
  updated_at timestamptz not null default now(),
  primary key (owner_id, key)
);

-- All access is through the authenticated server and participant checks.
do $$ declare table_name text; begin
  foreach table_name in array array['pilot_exchanges','pilot_private_inputs','pilot_items',
    'pilot_messages','pilot_approvals','pilot_operations','pilot_events','pilot_commands',
    'pilot_assets','pilot_preferences','pilot_setup_operations'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end $$;
