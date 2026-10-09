alter table public.dashboard_assignments
  add column if not exists client_buffer_detail_tabs jsonb not null default '{}'::jsonb;
