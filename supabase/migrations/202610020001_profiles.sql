create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username = lower(username)),
  display_name text not null,
  google_email text not null,
  client_name text not null default 'My spreadsheets',
  role text not null default 'user' check (role in ('admin', 'user')),
  status text not null default 'default' check (status in ('active', 'inactive', 'default')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;

create policy "Users can read their own profile"
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());