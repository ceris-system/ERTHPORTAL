alter table public.profiles
  drop constraint if exists profiles_username_check;

alter table public.profiles
  add constraint profiles_username_format_check
  check (username ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$');

update public.profiles
set client_name = 'ADMIN'
where role = 'admin'
  and is_master_admin = false;
