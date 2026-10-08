alter table public.dashboard_assignments
  add column if not exists client_sheet_urls jsonb not null default '{}'::jsonb;
