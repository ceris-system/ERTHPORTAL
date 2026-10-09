alter table public.dashboard_assignments
  add column if not exists client_deactivation_mika_tabs jsonb not null default '{}'::jsonb;
