alter table public.profiles
  add column if not exists photo_url text not null default '',
  add column if not exists sheet_url text not null default '';
