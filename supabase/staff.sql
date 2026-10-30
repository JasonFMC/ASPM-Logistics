-- 同事账号。谷歌邮箱仍是登录大门；共用同一只邮箱的人在门内各自建同事。
-- 短密码另存在 staff_secrets，只有管理员的员工页能看到。页面不能直接读这张表。
-- 在 supabase/tickets.sql 之后执行。可以重复执行。

create extension if not exists "pgcrypto";

alter table public.profiles
  add column if not exists is_desk_admin boolean not null default false;

-- 和仓库底图管理员是同一批登录邮箱。
update public.profiles
set is_desk_admin = true
where id in (
  select id from auth.users
  where lower(email) in (
    'aspmriverwood@gmail.com',
    'jasonwangzeyu@gmail.com'
  )
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null,
  hue int not null default 0 check (hue between 0 and 7),
  look jsonb,
  created_at timestamptz not null default now(),
  unique (owner_id, display_name)
);

create table if not exists public.staff_secrets (
  staff_id uuid primary key references public.staff (id) on delete cascade,
  pin_hash text not null
);

create table if not exists public.staff_sessions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null
);

alter table public.tickets
  add column if not exists claimed_by uuid references public.staff (id) on delete set null;

create index if not exists tickets_claimed_by_idx on public.tickets (claimed_by);

alter table public.tickets drop constraint if exists tickets_claimed_by_fkey;
alter table public.tickets
  add constraint tickets_claimed_by_fkey
  foreign key (claimed_by) references public.staff (id) on delete restrict;

alter table public.staff
  add column if not exists look jsonb;

alter table public.staff
  add column if not exists hidden boolean not null default false;

alter table public.staff
  add column if not exists has_claimed boolean not null default false;

update public.staff as s
set has_claimed = true
where s.id in (select claimed_by from public.tickets where claimed_by is not null)
   or exists (
     select 1 from public.ticket_events as e
     where e.note = s.display_name || ' 领取了任务'
   );

alter table public.staff_secrets
  add column if not exists pin_text text;

alter table public.staff enable row level security;
alter table public.staff_secrets enable row level security;
alter table public.staff_sessions enable row level security;

drop policy if exists "staff_select_auth" on public.staff;
create policy "staff_select_auth" on public.staff
  for select to authenticated using (true);

-- staff_secrets 没有 select 策略，页面不能直接读。管理员通过 admin_staff_list 查看密码。

create or replace function public.guard_ticket_claim()
returns trigger
language plpgsql
as $$
begin
  if new.claimed_by is distinct from old.claimed_by
     and current_setting('aspm.claim', true) is distinct from '1' then
    raise exception '领取必须经过核对';
  end if;
  return new;
end;
$$;

drop trigger if exists tickets_guard_claim on public.tickets;
create trigger tickets_guard_claim
  before update on public.tickets
  for each row
  execute function public.guard_ticket_claim();

drop function if exists public.create_staff(text, text, int);

create or replace function public.create_staff(p_name text, p_pin text, p_hue int, p_look jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  name text := trim(p_name);
  created public.staff;
begin
  if uid is null then
    raise exception '未登录';
  end if;
  if name is null or char_length(name) < 1 or char_length(name) > 20 then
    raise exception '名字用 1 到 20 个字';
  end if;
  if p_pin is null or char_length(p_pin) < 4 or char_length(p_pin) > 20 then
    raise exception '短密码用 4 到 20 位';
  end if;
  if p_look is not null then
    if jsonb_typeof(p_look) is distinct from 'object'
       or coalesce(p_look ->> 'face', '') !~ '^[0-3]$'
       or coalesce(p_look ->> 'eyes', '') !~ '^[0-3]$'
       or coalesce(p_look ->> 'ears', '') !~ '^[0-3]$'
       or coalesce(p_look ->> 'mouth', '') !~ '^[0-3]$'
       or coalesce(p_look ->> 'backdrop', '') !~ '^[0-3]$'
       or coalesce(p_look ->> 'color', '') !~ '^[0-7]$' then
      raise exception '头像拼得不完整';
    end if;
    p_hue := (p_look ->> 'color')::int;
  end if;
  if p_hue is null or p_hue < 0 or p_hue > 7 then
    raise exception '请选一个头像';
  end if;
  if exists (
    select 1 from public.staff
    where owner_id = uid and lower(display_name) = lower(name)
  ) then
    raise exception '这只邮箱下已经有这个名字';
  end if;

  insert into public.staff (owner_id, display_name, hue, look)
  values (uid, name, p_hue, p_look)
  returning * into created;

  insert into public.staff_secrets (staff_id, pin_hash, pin_text)
  values (created.id, crypt(p_pin, gen_salt('bf')), p_pin);

  return jsonb_build_object(
    'id', created.id,
    'display_name', created.display_name,
    'hue', created.hue,
    'look', created.look
  );
end;
$$;

create or replace function public.enter_desk(p_staff_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  uid uuid := auth.uid();
  person public.staff;
  secret text;
  token text;
begin
  if uid is null then
    raise exception '未登录';
  end if;

  select * into person from public.staff where id = p_staff_id and owner_id = uid;
  if not found then
    raise exception '这只邮箱下没有这位同事';
  end if;
  if person.hidden then
    raise exception '这位员工已隐藏';
  end if;

  select pin_hash into secret from public.staff_secrets where staff_id = person.id;
  if secret is null or crypt(p_pin, secret) <> secret then
    raise exception '短密码不对';
  end if;

  token := encode(gen_random_bytes(32), 'hex');
  insert into public.staff_sessions (staff_id, token_hash, expires_at)
  values (person.id, encode(digest(token, 'sha256'), 'hex'), now() + interval '12 hours');

  return jsonb_build_object(
    'token', token,
    'id', person.id,
    'display_name', person.display_name,
    'hue', person.hue,
    'look', person.look
  );
end;
$$;

create or replace function public.desk_staff(p_token text)
returns public.staff
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  person public.staff;
begin
  if auth.uid() is null or p_token is null or p_token = '' then
    raise exception '请先选自己的名字';
  end if;
  select s.* into person
  from public.staff_sessions sess
  join public.staff s on s.id = sess.staff_id
  where sess.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and sess.expires_at > now()
    and s.owner_id = auth.uid();
  if not found then
    raise exception '身份已过期，请重新输入短密码';
  end if;
  return person;
end;
$$;

create or replace function public.claim_ticket(p_ticket_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  who public.staff;
  current uuid;
  status text;
begin
  who := public.desk_staff(p_token);
  select claimed_by, tickets.status into current, status from public.tickets where id = p_ticket_id;
  if status is null then
    raise exception '找不到这张工单';
  end if;
  if current is not null then
    raise exception '已经有人领了';
  end if;
  perform set_config('aspm.claim', '1', true);
  update public.tickets set claimed_by = who.id, updated_at = now() where id = p_ticket_id;
  update public.staff set has_claimed = true where id = who.id;
  insert into public.ticket_events (ticket_id, from_status, to_status, actor_id, note)
  values (p_ticket_id, status, status, auth.uid(), who.display_name || ' 领取了任务');
end;
$$;

create or replace function public.release_ticket(p_ticket_id uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  who public.staff;
  current uuid;
  status text;
  admin boolean;
begin
  who := public.desk_staff(p_token);
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  select claimed_by, tickets.status into current, status from public.tickets where id = p_ticket_id;
  if status is null then
    raise exception '找不到这张工单';
  end if;
  if current is null then
    return;
  end if;
  if current is distinct from who.id and admin is not true then
    raise exception '只能放回自己领取的任务';
  end if;
  perform set_config('aspm.claim', '1', true);
  update public.tickets set claimed_by = null, updated_at = now() where id = p_ticket_id;
  insert into public.ticket_events (ticket_id, from_status, to_status, actor_id, note)
  values (p_ticket_id, status, status, auth.uid(), who.display_name || ' 放回了任务');
end;
$$;

create or replace function public.reassign_ticket(p_ticket_id uuid, p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  admin boolean;
  status text;
  name text;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  if admin is not true then
    raise exception '只有管理员可以改派';
  end if;
  select tickets.status into status from public.tickets where id = p_ticket_id;
  if status is null then
    raise exception '找不到这张工单';
  end if;
  if p_staff_id is not null then
    select display_name into name from public.staff where id = p_staff_id;
    if name is null then
      raise exception '没有这位员工';
    end if;
    update public.staff set has_claimed = true where id = p_staff_id;
  end if;
  perform set_config('aspm.claim', '1', true);
  update public.tickets
  set claimed_by = p_staff_id, updated_at = now()
  where id = p_ticket_id;
  insert into public.ticket_events (ticket_id, from_status, to_status, actor_id, note)
  values (
    p_ticket_id,
    status,
    status,
    auth.uid(),
    case when name is null then '管理员收回了任务' else '管理员改派给 ' || name end
  );
end;
$$;

create or replace function public.admin_staff_list()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  admin boolean;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  if admin is not true then
    raise exception '只有管理员可以管理员工';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(rows))
    from (
      select
        s.id,
        s.display_name,
        s.hue,
        s.look,
        s.hidden,
        s.has_claimed,
        sec.pin_text as pin,
        (select count(*) from public.tickets t where t.claimed_by = s.id) as open_count,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title) order by t.updated_at desc)
          from public.tickets t
          where t.claimed_by = s.id
        ), '[]'::jsonb) as tickets
      from public.staff s
      left join public.staff_secrets sec on sec.staff_id = s.id
      order by s.hidden, s.display_name
    ) rows
  ), '[]'::jsonb);
end;
$$;

create or replace function public.update_my_staff(p_token text, p_name text, p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  who public.staff;
  name text := trim(p_name);
  pin text := nullif(trim(coalesce(p_pin, '')), '');
begin
  who := public.desk_staff(p_token);
  if name is null or char_length(name) < 1 or char_length(name) > 20 then
    raise exception '名字用 1 到 20 个字';
  end if;
  if pin is not null and (char_length(pin) < 4 or char_length(pin) > 20) then
    raise exception '密码用 4 到 20 位';
  end if;
  if lower(name) is distinct from lower(who.display_name) and exists (
    select 1 from public.staff
    where owner_id = who.owner_id
      and id <> who.id
      and lower(display_name) = lower(name)
  ) then
    raise exception '这只邮箱下已经有这个名字';
  end if;
  update public.staff set display_name = name where id = who.id;
  if pin is not null then
    update public.staff_secrets
    set pin_hash = crypt(pin, gen_salt('bf')),
        pin_text = pin
    where staff_id = who.id;
  end if;
  return name;
end;
$$;

create or replace function public.rename_staff(p_staff_id uuid, p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  admin boolean;
  person public.staff;
  name text := trim(p_name);
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  if admin is not true then
    raise exception '只有管理员可以管理员工';
  end if;
  if name is null or char_length(name) < 1 or char_length(name) > 20 then
    raise exception '名字用 1 到 20 个字';
  end if;
  select * into person from public.staff where id = p_staff_id;
  if not found then
    raise exception '没有这位员工';
  end if;
  if exists (
    select 1 from public.staff
    where owner_id = person.owner_id
      and id <> person.id
      and lower(display_name) = lower(name)
  ) then
    raise exception '这只邮箱下已经有这个名字';
  end if;
  update public.staff set display_name = name where id = person.id;
end;
$$;

create or replace function public.set_staff_hidden(p_staff_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  admin boolean;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  if admin is not true then
    raise exception '只有管理员可以管理员工';
  end if;
  update public.staff set hidden = coalesce(p_hidden, false) where id = p_staff_id;
  if not found then
    raise exception '没有这位员工';
  end if;
end;
$$;

create or replace function public.delete_staff(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  admin boolean;
  person public.staff;
begin
  if auth.uid() is null then
    raise exception '未登录';
  end if;
  select is_desk_admin into admin from public.profiles where id = auth.uid();
  if admin is not true then
    raise exception '只有管理员可以管理员工';
  end if;
  select * into person from public.staff where id = p_staff_id;
  if not found then
    raise exception '没有这位员工';
  end if;
  if person.has_claimed or exists (select 1 from public.tickets where claimed_by = person.id) then
    raise exception '领取过工单的员工不能删除，可以隐藏';
  end if;
  delete from public.staff where id = person.id;
end;
$$;

revoke all on function public.create_staff(text, text, int, jsonb) from public;
revoke all on function public.enter_desk(uuid, text) from public;
revoke all on function public.desk_staff(text) from public;
revoke all on function public.claim_ticket(uuid, text) from public;
revoke all on function public.release_ticket(uuid, text) from public;
revoke all on function public.reassign_ticket(uuid, uuid) from public;
revoke all on function public.admin_staff_list() from public;
revoke all on function public.rename_staff(uuid, text) from public;
revoke all on function public.set_staff_hidden(uuid, boolean) from public;
revoke all on function public.delete_staff(uuid) from public;
revoke all on function public.update_my_staff(text, text, text) from public;

grant execute on function public.create_staff(text, text, int, jsonb) to authenticated;
grant execute on function public.enter_desk(uuid, text) to authenticated;
grant execute on function public.claim_ticket(uuid, text) to authenticated;
grant execute on function public.release_ticket(uuid, text) to authenticated;
grant execute on function public.reassign_ticket(uuid, uuid) to authenticated;
grant execute on function public.admin_staff_list() to authenticated;
grant execute on function public.rename_staff(uuid, text) to authenticated;
grant execute on function public.set_staff_hidden(uuid, boolean) to authenticated;
grant execute on function public.delete_staff(uuid) to authenticated;
grant execute on function public.update_my_staff(text, text, text) to authenticated;

notify pgrst, 'reload schema';
