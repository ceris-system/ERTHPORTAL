alter table public.dashboard_assignments
  add column if not exists client_vcode_deleted_tabs jsonb not null default '{}'::jsonb;
