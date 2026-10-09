alter table public.dashboard_assignments
  add column if not exists client_vcode_source_tabs jsonb not null default '{}'::jsonb;
