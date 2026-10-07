alter table public.profiles
  add column if not exists is_master_admin boolean not null default false,
  add column if not exists client_names text[] not null default '{}';

update public.profiles
set is_master_admin = true
where username = 'admin' and role = 'admin';

alter table public.dashboard_assignments
  add column if not exists client_names text[] not null default '{}';
