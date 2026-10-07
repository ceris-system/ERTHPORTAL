alter table public.profiles
  add column if not exists managed_user_ids uuid[];
