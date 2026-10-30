-- 工作流：模板、版本、步骤、连线，以及工单上的实际环节。
-- 核心规则：建单时把模板步骤「复印」到工单上，之后改模板不影响在跑的单。
-- 在 supabase/tickets.sql 之后执行。可以重复执行。

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 模板
-- ---------------------------------------------------------------------------

-- 一条流程，比如「发货（我们运输）」。工单靠它当标签。
create table if not exists public.workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  color text,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (name)
);

-- 每次编辑模板生成一个新版本。工单记住自己是从哪一版来的。
create table if not exists public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows (id) on delete cascade,
  version int not null,
  note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workflow_id, version)
);

-- 模板里的一步。
-- step_key 是不变的内部编号：name 随便改，统计按 step_key 归类。
create table if not exists public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.workflow_versions (id) on delete cascade,
  step_key text not null,
  name text not null,
  description text,
  sort_order int not null default 0,
  kind text not null default 'manual'
    check (kind in ('manual', 'ai', 'email', 'wait_external', 'print', 'photo')),
  -- 条件分支先用「可跳过」实现，不做真正的条件连线。
  optional boolean not null default false,
  remind_after interval,
  remind_note text,
  -- 画布坐标，给可视化编辑器用。
  pos_x double precision,
  pos_y double precision,
  unique (version_id, step_key)
);

create index if not exists workflow_steps_version_idx
  on public.workflow_steps (version_id, sort_order);

-- 步骤之间的连线。存成有向图，画布画箭头用；执行时只看「前面的都做完了没」。
create table if not exists public.workflow_edges (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.workflow_versions (id) on delete cascade,
  from_step_id uuid not null references public.workflow_steps (id) on delete cascade,
  to_step_id uuid not null references public.workflow_steps (id) on delete cascade,
  label text,
  unique (version_id, from_step_id, to_step_id)
);

-- ---------------------------------------------------------------------------
-- 工单侧
-- ---------------------------------------------------------------------------

alter table public.tickets
  add column if not exists assignee_id uuid references auth.users (id) on delete set null,
  add column if not exists workflow_id uuid references public.workflows (id) on delete set null,
  add column if not exists workflow_version_id uuid references public.workflow_versions (id) on delete set null,
  -- AI 从邮件里抽出来的货物信息。先放弹性字段，等哪几项稳定了再提升成正式列。
  add column if not exists facts jsonb not null default '{}'::jsonb,
  add column if not exists facts_extracted_at timestamptz,
  -- 抽错是一定会发生的，所以必须分得清哪些是人确认过的。
  add column if not exists facts_confirmed_at timestamptz,
  add column if not exists facts_confirmed_by uuid references auth.users (id) on delete set null,
  add column if not exists closed_at timestamptz;

alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check
  check (status in ('new', 'in_progress', 'waiting', 'done', 'cancelled'));

-- 工单上的实际环节：建单时从模板复印过来的快照。
create table if not exists public.ticket_stages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  step_key text not null,
  name text not null,
  description text,
  sort_order int not null default 0,
  kind text not null default 'manual',
  optional boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'active', 'waiting', 'done', 'skipped')),
  assignee_id uuid references auth.users (id) on delete set null,
  -- 进入和离开这一步的时间。停留多久 = now() - started_at。
  started_at timestamptz,
  completed_at timestamptz,
  remind_after interval,
  remind_note text,
  snoozed_until timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ticket_id, step_key)
);

create index if not exists ticket_stages_ticket_idx
  on public.ticket_stages (ticket_id, sort_order);
create index if not exists ticket_stages_open_idx
  on public.ticket_stages (status, started_at)
  where status in ('active', 'waiting');

-- 拖动工单是一次人工纠正，必须留痕，否则停留时长的记录就不可信了。
alter table public.ticket_events
  add column if not exists stage_id uuid references public.ticket_stages (id) on delete set null;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.workflows enable row level security;
alter table public.workflow_versions enable row level security;
alter table public.workflow_steps enable row level security;
alter table public.workflow_edges enable row level security;
alter table public.ticket_stages enable row level security;

drop policy if exists "workflows_all_auth" on public.workflows;
create policy "workflows_all_auth" on public.workflows
  for all to authenticated using (true) with check (true);

drop policy if exists "workflow_versions_all_auth" on public.workflow_versions;
create policy "workflow_versions_all_auth" on public.workflow_versions
  for all to authenticated using (true) with check (true);

drop policy if exists "workflow_steps_all_auth" on public.workflow_steps;
create policy "workflow_steps_all_auth" on public.workflow_steps
  for all to authenticated using (true) with check (true);

drop policy if exists "workflow_edges_all_auth" on public.workflow_edges;
create policy "workflow_edges_all_auth" on public.workflow_edges
  for all to authenticated using (true) with check (true);

drop policy if exists "ticket_stages_all_auth" on public.ticket_stages;
create policy "ticket_stages_all_auth" on public.ticket_stages
  for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 复印：把模板的最新版本套到一张工单上
-- ---------------------------------------------------------------------------

create or replace function public.apply_workflow(p_ticket_id uuid, p_workflow_id uuid)
returns void
language plpgsql
security invoker
as $$
declare
  v_version_id uuid;
  v_first_order int;
begin
  select id into v_version_id
  from public.workflow_versions
  where workflow_id = p_workflow_id
  order by version desc
  limit 1;

  if v_version_id is null then
    raise exception '这条流程还没有版本';
  end if;

  -- 复印，不是引用。以后改模板不会动到这张单。
  insert into public.ticket_stages (
    ticket_id, step_key, name, description, sort_order,
    kind, optional, remind_after, remind_note
  )
  select
    p_ticket_id, s.step_key, s.name, s.description, s.sort_order,
    s.kind, s.optional, s.remind_after, s.remind_note
  from public.workflow_steps s
  where s.version_id = v_version_id
  on conflict (ticket_id, step_key) do nothing;

  update public.tickets
  set workflow_id = p_workflow_id,
      workflow_version_id = v_version_id,
      updated_at = now()
  where id = p_ticket_id;

  -- 第一步直接开始计时。
  select min(sort_order) into v_first_order
  from public.ticket_stages
  where ticket_id = p_ticket_id;

  update public.ticket_stages
  set status = 'active', started_at = now(), updated_at = now()
  where ticket_id = p_ticket_id
    and sort_order = v_first_order
    and status = 'pending';
end;
$$;

-- ---------------------------------------------------------------------------
-- 超时待办。是视图不是表，所以不会出现「提醒还在但单子早做完了」。
-- ---------------------------------------------------------------------------

drop view if exists public.v_stage_alerts;
create view public.v_stage_alerts
with (security_invoker = on)
as
select
  s.id            as stage_id,
  s.ticket_id,
  s.step_key,
  s.name          as stage_name,
  s.kind,
  s.status        as stage_status,
  s.assignee_id,
  s.started_at,
  s.remind_after,
  s.remind_note,
  now() - s.started_at              as stuck_for,
  now() - (s.started_at + s.remind_after) as overdue_by,
  t.title,
  t.status        as ticket_status,
  t.batch,
  t.warehouse_id,
  t.customer_id,
  t.workflow_id
from public.ticket_stages s
join public.tickets t on t.id = s.ticket_id
where s.status in ('active', 'waiting')
  and s.remind_after is not null
  and s.started_at is not null
  and s.started_at + s.remind_after <= now()
  and (s.snoozed_until is null or s.snoozed_until <= now())
  and t.status not in ('done', 'cancelled');

grant select on public.v_stage_alerts to authenticated;

-- ---------------------------------------------------------------------------
-- 预置五条流程
-- ---------------------------------------------------------------------------

-- 只在流程不存在时建。已经存在就跳过，不覆盖你在页面上的改动。
create or replace function public.seed_workflow(
  p_name text,
  p_description text,
  p_steps jsonb
)
returns void
language plpgsql
as $$
declare
  v_workflow_id uuid;
  v_version_id uuid;
  v_step jsonb;
  v_prev uuid;
  v_curr uuid;
  v_i int := 0;
begin
  select id into v_workflow_id from public.workflows where name = p_name;
  if v_workflow_id is not null then
    return;
  end if;

  insert into public.workflows (name, description)
  values (p_name, p_description)
  returning id into v_workflow_id;

  insert into public.workflow_versions (workflow_id, version, note)
  values (v_workflow_id, 1, '初始版本')
  returning id into v_version_id;

  for v_step in select * from jsonb_array_elements(p_steps)
  loop
    v_i := v_i + 1;

    insert into public.workflow_steps (
      version_id, step_key, name, description, sort_order,
      kind, optional, remind_after, remind_note, pos_x, pos_y
    ) values (
      v_version_id,
      v_step ->> 'key',
      v_step ->> 'name',
      v_step ->> 'desc',
      v_i,
      coalesce(v_step ->> 'kind', 'manual'),
      coalesce((v_step ->> 'optional')::boolean, false),
      case when (v_step ->> 'remind') is null
        then null else (v_step ->> 'remind')::interval end,
      v_step ->> 'remind_note',
      160 + ((v_i - 1) % 4) * 260,
      140 + ((v_i - 1) / 4) * 190
    ) returning id into v_curr;

    if v_prev is not null then
      insert into public.workflow_edges (version_id, from_step_id, to_step_id)
      values (v_version_id, v_prev, v_curr);
    end if;

    v_prev := v_curr;
  end loop;
end;
$$;

select public.seed_workflow(
  '发货（我们运输）',
  '我们代客户安排承运商取货送货。',
  '[
    {"key":"read_mail","name":"读邮件、确认信息","kind":"manual",
     "desc":"确认客户是谁、货物信息、发货地址、额外注意事项。"},
    {"key":"check_address","name":"AI 查地址","kind":"ai",
     "desc":"判断是 business 还是 residential address，以及对方有叉车的可能性。"},
    {"key":"ask_address","name":"发邮件询问地址信息","kind":"email","optional":true,
     "desc":"AI 判断不确定时才做。判断明确就跳过。"},
    {"key":"wait_address_reply","name":"等客户回复地址确认","kind":"wait_external",
     "optional":true,"remind":"2 days","remind_note":"地址还没确认，无法订运输。"},
    {"key":"enter_tw","name":"录入 TradeWindow","kind":"manual"},
    {"key":"prepare","name":"做单、安排仓库准备货物","kind":"manual"},
    {"key":"confirm_ready","name":"确认准备完成","kind":"manual"},
    {"key":"book_transport","name":"订运输","kind":"manual"},
    {"key":"print_docs","name":"打印 label 和所需文件","kind":"print"},
    {"key":"notify_customer","name":"发邮件通知客户","kind":"email",
     "desc":"附上相关文件和追踪码。"},
    {"key":"wait_pickup","name":"等待运输公司取货","kind":"wait_external",
     "remind":"1 day","remind_note":"运输公司还没来取货，需要催。"},
    {"key":"confirm_picked","name":"确认取完货","kind":"manual"},
    {"key":"send_pod","name":"发邮件告知客户","kind":"email",
     "desc":"附上 loading photo 和 POD。"}
  ]'::jsonb
);

select public.seed_workflow(
  '发货（客户自己订车）',
  '客户自己安排承运商，我们备货并提供文件。',
  '[
    {"key":"read_mail","name":"读邮件、确认信息","kind":"manual",
     "desc":"确认客户是谁、货物信息、额外注意事项。"},
    {"key":"enter_tw","name":"录入 TradeWindow","kind":"manual"},
    {"key":"prepare","name":"做单、安排仓库准备货物","kind":"manual"},
    {"key":"confirm_ready","name":"确认准备完成","kind":"manual"},
    {"key":"notify_ready","name":"发邮件告知准备完成","kind":"email",
     "desc":"附 SN、Packing List，以及货物 dimension（格式待补）。"},
    {"key":"wait_customer_docs","name":"等客户回复（含 label 和文件）","kind":"wait_external",
     "remind":"2 days","remind_note":"客户还没给 label，运输公司来了也取不走。"},
    {"key":"print_docs","name":"打印 label 和所需文件","kind":"print"},
    {"key":"wait_pickup","name":"等待运输公司取货","kind":"wait_external",
     "remind":"1 day","remind_note":"运输公司还没来取货。"},
    {"key":"confirm_picked","name":"确认取完货","kind":"manual"},
    {"key":"send_pod","name":"发邮件告知客户","kind":"email",
     "desc":"附上 loading photo 和 POD。"}
  ]'::jsonb
);

select public.seed_workflow(
  '发货（客户自提）',
  '客户自己上门取货。',
  '[
    {"key":"read_mail","name":"读邮件、确认信息","kind":"manual",
     "desc":"确认客户是谁、货物信息、额外注意事项。"},
    {"key":"enter_tw","name":"录入 TradeWindow","kind":"manual"},
    {"key":"prepare","name":"做单、安排仓库准备货物","kind":"manual"},
    {"key":"confirm_ready","name":"确认准备完成","kind":"manual"},
    {"key":"notify_ready","name":"发邮件告知准备完成","kind":"email",
     "desc":"附 SN、Packing List，以及货物 dimension（格式待补）。"},
    {"key":"wait_customer_reply","name":"等客户回复","kind":"wait_external",
     "remind":"2 days","remind_note":"客户还没回复取货安排。"},
    {"key":"wait_customer_pickup","name":"等客户取货","kind":"wait_external",
     "remind":"3 days","remind_note":"货备好了但客户一直没来取，占着位置。"},
    {"key":"confirm_picked","name":"确认取完货","kind":"manual"},
    {"key":"send_pod","name":"发邮件告知客户","kind":"email",
     "desc":"附上 loading photo 和 POD。"}
  ]'::jsonb
);

select public.seed_workflow(
  '发货（玻璃运送）',
  '这家不需要 POD，拍照自留证据即可。库位核对以后接 YARD。',
  '[
    {"key":"read_mail","name":"读邮件、确认信息","kind":"manual",
     "desc":"确认客户是谁、货物信息、额外注意事项。"},
    {"key":"make_excel","name":"根据邮件摘要生成 Excel","kind":"ai"},
    {"key":"print_excel","name":"打印 Excel","kind":"print"},
    {"key":"worker_prepare","name":"给工人准备","kind":"manual"},
    {"key":"verify_stock","name":"错误排查：确认库存和所需物件正确","kind":"manual",
     "desc":"以后可以直接连到 YARD 的库位核对。"},
    {"key":"fix_tradewindow","name":"在 TradeWindow 修正","kind":"manual","optional":true,
     "desc":"只有查出错误时才做。"},
    {"key":"confirm_correct","name":"确认无误","kind":"manual"},
    {"key":"enter_tw","name":"录入 TradeWindow","kind":"manual"},
    {"key":"driver_doc","name":"做单、打印给取货司机","kind":"print"},
    {"key":"wait_driver","name":"等司机取货","kind":"wait_external",
     "remind":"1 day","remind_note":"司机还没来取。"},
    {"key":"photo_evidence","name":"拍照存证（已运走）","kind":"photo",
     "desc":"这家不发 POD，自己留记录就行。"}
  ]'::jsonb
);

select public.seed_workflow(
  '收货（faulty collection）',
  '从客户地址把货收回我们仓库。等货到仓是最容易漏掉的一步。',
  '[
    {"key":"read_mail","name":"读邮件、确认信息","kind":"manual",
     "desc":"确认客户是谁、货物信息、额外注意事项。"},
    {"key":"check_address","name":"AI 查地址","kind":"ai",
     "desc":"判断是 business 还是 residential address，以及对方有叉车的可能性。"},
    {"key":"ask_address","name":"发邮件询问地址信息","kind":"email","optional":true,
     "desc":"AI 判断不确定时才做。"},
    {"key":"wait_address_reply","name":"等客户回复地址确认","kind":"wait_external",
     "optional":true,"remind":"2 days","remind_note":"地址还没确认，无法订运输。"},
    {"key":"tw_create","name":"TradeWindow 起单、拿单号","kind":"manual"},
    {"key":"book_transport","name":"订运输（客户地址 → 我们仓库）","kind":"manual"},
    {"key":"save_docs","name":"保存 label 和所需文件","kind":"manual"},
    {"key":"notify_customer","name":"发邮件给客户","kind":"email",
     "desc":"附上追踪码、label 和所需文件。"},
    {"key":"wait_arrival","name":"等待货物到达仓库","kind":"wait_external",
     "remind":"2 days","remind_note":"货还没到仓。这一步最容易忘，到了要去确认。"},
    {"key":"verify_received","name":"确认数量和内容正确","kind":"manual"},
    {"key":"tw_inbound","name":"在 TradeWindow 做入库","kind":"manual"}
  ]'::jsonb
);
