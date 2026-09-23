-- Existing message RLS/grants apply to these delivery fields. No private data
-- is copied into A2A state; the wire carries only the immutable message identity.
alter table public.pilot_messages
  add column a2a_received_at timestamptz,
  add column a2a_task_id text,
  add column a2a_attempts integer not null default 0 check (a2a_attempts >= 0),
  add column a2a_attempted_at timestamptz;

create index pilot_messages_a2a_outbox_idx on public.pilot_messages(sender_id, created_at)
  where sender_id <> recipient_id and a2a_received_at is null;
