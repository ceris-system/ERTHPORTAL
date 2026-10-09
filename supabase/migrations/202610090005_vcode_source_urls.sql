alter table public.dashboard_assignments
  add column if not exists client_vcode_source_urls jsonb not null default '{}'::jsonb;
