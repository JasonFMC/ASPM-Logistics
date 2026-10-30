-- Tickets: store task records only. Original mail stays in the mailbox.
-- Run in Supabase SQL Editor after the yard schema.
-- Workflow tables live in supabase/workflows.sql. Run that file after this one.

create extension if not exists "pgcrypto";

-- 仓库。可改名（36 号仓在搬迁，以后可能换名字）。
create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_home boolean not null default false,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (name)
);

-- 固定客户白名单。新发件人先不建客户，只在工单上标「新客户」。
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  warehouse_id uuid references public.warehouses (id) on delete set null,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (name)
);

-- 认客户用的地址。pattern 可以是整个地址 abc@x.com，也可以是域名 @x.com。
create table if not exists public.customer_senders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  pattern text not null,
  created_at timestamptz not null default now(),
  unique (pattern)
);

create index if not exists customer_senders_customer_idx
  on public.customer_senders (customer_id);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  status text not null default 'new'
    check (status in ('new', 'in_progress', 'done')),
  source text not null default 'manual'
    check (source in ('email', 'manual')),
  -- 'test' 是头一次试拉的那批，测完归档，不和生产混在一起。
  batch text not null default 'live'
    check (batch in ('test', 'live')),
  warehouse_id uuid references public.warehouses (id) on delete set null,
  customer_id uuid references public.customers (id) on delete set null,
  is_new_sender boolean not null default false,
  -- 认信用。message_id 是邮件自带的编号，用来防重。
  mailbox text,
  message_id text,
  imap_uid bigint,
  from_name text,
  from_email text,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tickets_message_id_uidx
  on public.tickets (message_id)
  where message_id is not null;

create unique index if not exists tickets_mailbox_uid_uidx
  on public.tickets (mailbox, imap_uid)
  where imap_uid is not null;

create index if not exists tickets_status_idx on public.tickets (status, received_at desc);
create index if not exists tickets_updated_idx on public.tickets (updated_at desc);
create index if not exists tickets_batch_idx on public.tickets (batch, updated_at desc);
create index if not exists tickets_warehouse_idx on public.tickets (warehouse_id, status);

create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references auth.users (id) on delete set null,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists ticket_events_ticket_idx on public.ticket_events (ticket_id, created_at);

-- 记住上次拉到哪，之后只拉新信。
create table if not exists public.mail_sync_state (
  mailbox text primary key,
  last_uid bigint,
  uid_validity bigint,
  last_synced_at timestamptz
);

alter table public.warehouses enable row level security;
alter table public.customers enable row level security;
alter table public.customer_senders enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_events enable row level security;
alter table public.mail_sync_state enable row level security;

drop policy if exists "warehouses_all_auth" on public.warehouses;
create policy "warehouses_all_auth" on public.warehouses
  for all to authenticated using (true) with check (true);

drop policy if exists "customers_all_auth" on public.customers;
create policy "customers_all_auth" on public.customers
  for all to authenticated using (true) with check (true);

drop policy if exists "customer_senders_all_auth" on public.customer_senders;
create policy "customer_senders_all_auth" on public.customer_senders
  for all to authenticated using (true) with check (true);

drop policy if exists "tickets_all_auth" on public.tickets;
create policy "tickets_all_auth" on public.tickets
  for all to authenticated using (true) with check (true);

drop policy if exists "ticket_events_all_auth" on public.ticket_events;
create policy "ticket_events_all_auth" on public.ticket_events
  for all to authenticated using (true) with check (true);

-- 同步进度只给函数（service role）写，前端不需要碰。
drop policy if exists "mail_sync_state_read_auth" on public.mail_sync_state;
create policy "mail_sync_state_read_auth" on public.mail_sync_state
  for select to authenticated using (true);

-- 本仓和 36 号仓。名字以后可以在页面上改。
insert into public.warehouses (name, is_home, sort_order)
select '本仓', true, 0
where not exists (select 1 from public.warehouses where is_home);

insert into public.warehouses (name, is_home, sort_order)
select '36 号仓', false, 1
where not exists (select 1 from public.warehouses where name = '36 号仓');
