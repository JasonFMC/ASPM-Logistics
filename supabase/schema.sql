-- ASPM YARD MVP schema (run in Supabase SQL Editor)
-- Region: Sydney (ap-southeast-2)

create extension if not exists "pgcrypto";

-- Profiles (optional display name)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.sites (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'ASPM Yard',
  basemap_path text,
  basemap_width int not null default 2000,
  basemap_height int not null default 1400,
  -- real meters per image pixel; set by drawing a known ground length
  meters_per_pixel double precision,
  created_at timestamptz not null default now()
);

create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  code text not null,
  name text not null,
  color text not null default '#3b82f6',
  sort_order int not null default 0,
  -- polygon as [[x,y],...] in image pixel coords
  polygon jsonb,
  unique (site_id, code)
);

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  area_id uuid references public.areas (id) on delete set null,
  code text not null,
  label text,
  -- marker center in image pixel coords
  x double precision not null default 0,
  y double precision not null default 0,
  status text not null default 'empty'
    check (status in ('occupied', 'empty', 'pending_pickup', 'special')),
  notes text,
  created_at timestamptz not null default now(),
  unique (site_id, code)
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references public.sites (id) on delete cascade,
  code text not null,
  name text,
  description text,
  location_id uuid references public.locations (id) on delete set null,
  status text not null default 'in_yard'
    check (status in ('in_yard', 'pending_pickup', 'shipped', 'special')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (site_id, code)
);

create table if not exists public.movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  from_location_id uuid references public.locations (id) on delete set null,
  to_location_id uuid references public.locations (id) on delete set null,
  movement_type text not null
    check (movement_type in ('inbound', 'outbound', 'move', 'adjust')),
  operator_id uuid references auth.users (id) on delete set null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  movement_id uuid references public.movements (id) on delete set null,
  storage_path text not null,
  created_at timestamptz not null default now()
);

create index if not exists items_code_idx on public.items (code);
create index if not exists items_location_idx on public.items (location_id);
create index if not exists locations_code_idx on public.locations (code);
create index if not exists movements_item_idx on public.movements (item_id);

-- Auto profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep location status in sync with items
create or replace function public.refresh_location_status(p_location_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  has_pending boolean;
  has_special boolean;
  has_any boolean;
begin
  if p_location_id is null then
    return;
  end if;

  select
    exists (select 1 from items where location_id = p_location_id and status = 'pending_pickup'),
    exists (select 1 from items where location_id = p_location_id and status = 'special'),
    exists (select 1 from items where location_id = p_location_id and status in ('in_yard', 'pending_pickup', 'special'))
  into has_pending, has_special, has_any;

  update locations
  set status = case
    when has_special then 'special'
    when has_pending then 'pending_pickup'
    when has_any then 'occupied'
    else 'empty'
  end
  where id = p_location_id;
end;
$$;

create or replace function public.items_after_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.updated_at = now();
  end if;

  if tg_op = 'DELETE' then
    perform public.refresh_location_status(old.location_id);
    return old;
  end if;

  if tg_op = 'INSERT' then
    perform public.refresh_location_status(new.location_id);
    return new;
  end if;

  -- UPDATE
  if old.location_id is distinct from new.location_id then
    perform public.refresh_location_status(old.location_id);
    perform public.refresh_location_status(new.location_id);
  else
    perform public.refresh_location_status(new.location_id);
  end if;
  return new;
end;
$$;

drop trigger if exists items_after_change on public.items;
create trigger items_after_change
  after insert or update or delete on public.items
  for each row execute function public.items_after_change();

-- RLS: any authenticated user can read/write (log operator on movements in app)
alter table public.profiles enable row level security;
alter table public.sites enable row level security;
alter table public.areas enable row level security;
alter table public.locations enable row level security;
alter table public.items enable row level security;
alter table public.movements enable row level security;
alter table public.photos enable row level security;

create policy "profiles_select_auth" on public.profiles for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id);

create policy "sites_all_auth" on public.sites for all to authenticated using (true) with check (true);
create policy "areas_all_auth" on public.areas for all to authenticated using (true) with check (true);
create policy "locations_all_auth" on public.locations for all to authenticated using (true) with check (true);
create policy "items_all_auth" on public.items for all to authenticated using (true) with check (true);
create policy "movements_all_auth" on public.movements for all to authenticated using (true) with check (true);
create policy "photos_all_auth" on public.photos for all to authenticated using (true) with check (true);

-- Storage buckets (also create in Dashboard if needed)
insert into storage.buckets (id, name, public)
values ('basemaps', 'basemaps', true),
       ('photos', 'photos', true)
on conflict (id) do nothing;

create policy "basemaps_auth_read" on storage.objects for select to authenticated
  using (bucket_id = 'basemaps');
create policy "basemaps_auth_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'basemaps');
create policy "basemaps_auth_update" on storage.objects for update to authenticated
  using (bucket_id = 'basemaps');
create policy "basemaps_auth_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'basemaps');
create policy "basemaps_public_read" on storage.objects for select to anon
  using (bucket_id = 'basemaps');

create policy "photos_auth_read" on storage.objects for select to authenticated
  using (bucket_id = 'photos');
create policy "photos_auth_write" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos');
create policy "photos_auth_update" on storage.objects for update to authenticated
  using (bucket_id = 'photos');
create policy "photos_auth_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'photos');
create policy "photos_public_read" on storage.objects for select to anon
  using (bucket_id = 'photos');

-- Seed: only create empty site. Areas are created by users via 新建区域 → 手绘 → 取名.
insert into public.sites (name, basemap_width, basemap_height)
select 'ASPM Yard', 2000, 1400
where not exists (select 1 from public.sites);

-- Tickets tables live in supabase/tickets.sql. Run that file too.
