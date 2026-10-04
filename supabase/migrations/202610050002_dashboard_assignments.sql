create table if not exists public.dashboard_assignments (
  user_id uuid not null references public.profiles(id) on delete cascade,
  dashboard_name text not null,
  sheet_urls text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, dashboard_name)
);

alter table public.dashboard_assignments enable row level security;
revoke all on public.dashboard_assignments from anon, authenticated;