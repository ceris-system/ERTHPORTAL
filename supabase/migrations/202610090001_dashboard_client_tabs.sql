alter table public.dashboard_assignments
  add column if not exists sheet_tab text not null default '',
  add column if not exists client_sheet_tabs jsonb not null default '{}'::jsonb;
