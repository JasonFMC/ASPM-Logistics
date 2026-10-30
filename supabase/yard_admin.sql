-- 底图和像素比例只允许管理员改。已保存的 meters_per_pixel 不会被这句清掉。
-- 在 supabase/schema.sql 之后执行。可以重复执行。

alter table public.profiles
  add column if not exists is_yard_admin boolean not null default false;

-- 只把这两个登录邮箱设为管理员。其余账号一律关掉。
update public.profiles
set is_yard_admin = false;

update public.profiles
set is_yard_admin = true
where id in (
  select id from auth.users
  where lower(email) in (
    'aspmriverwood@gmail.com',
    'jasonwangzeyu@gmail.com'
  )
);

create or replace function public.guard_site_basemap()
returns trigger
language plpgsql
as $$
begin
  if new.basemap_path is not distinct from old.basemap_path
     and new.basemap_width is not distinct from old.basemap_width
     and new.basemap_height is not distinct from old.basemap_height
     and new.meters_per_pixel is not distinct from old.meters_per_pixel
  then
    return new;
  end if;

  if auth.uid() is null then
    return new;
  end if;

  if exists (
    select 1 from public.profiles
    where id = auth.uid() and is_yard_admin
  ) then
    return new;
  end if;

  raise exception '只有管理员可以更换底图或修改尺寸';
end;
$$;

drop trigger if exists sites_guard_basemap on public.sites;
create trigger sites_guard_basemap
  before update on public.sites
  for each row execute function public.guard_site_basemap();

drop policy if exists "basemaps_auth_write" on storage.objects;
drop policy if exists "basemaps_auth_update" on storage.objects;
drop policy if exists "basemaps_auth_delete" on storage.objects;
drop policy if exists "basemaps_admin_write" on storage.objects;
drop policy if exists "basemaps_admin_update" on storage.objects;
drop policy if exists "basemaps_admin_delete" on storage.objects;

create policy "basemaps_admin_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'basemaps'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and is_yard_admin
    )
  );

create policy "basemaps_admin_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'basemaps'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and is_yard_admin
    )
  );

create policy "basemaps_admin_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'basemaps'
    and exists (
      select 1 from public.profiles
      where id = auth.uid() and is_yard_admin
    )
  );
