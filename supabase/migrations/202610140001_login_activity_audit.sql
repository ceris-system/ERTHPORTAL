create table if not exists public.audit_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  username text not null,
  display_name text not null default '',
  role text not null,
  client_names text[] not null default '{}',
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text not null default '',
  user_agent text not null default ''
);

create table if not exists public.audit_events (
  id bigint generated always as identity primary key,
  session_id uuid references public.audit_sessions(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  actor_username text not null,
  occurred_at timestamptz not null default now(),
  event_type text not null,
  dashboard_name text not null default '',
  action text not null,
  target text not null default '',
  details jsonb not null default '{}'::jsonb
);

create index if not exists audit_sessions_started_at_idx
  on public.audit_sessions (started_at desc);

create index if not exists audit_sessions_user_started_at_idx
  on public.audit_sessions (user_id, started_at desc);

create index if not exists audit_events_session_occurred_at_idx
  on public.audit_events (session_id, occurred_at);

alter table public.audit_sessions enable row level security;
alter table public.audit_events enable row level security;

revoke all on public.audit_sessions from anon, authenticated;
revoke all on public.audit_events from anon, authenticated;
grant all on public.audit_sessions to service_role;
grant all on public.audit_events to service_role;
grant usage, select on sequence public.audit_events_id_seq to service_role;
