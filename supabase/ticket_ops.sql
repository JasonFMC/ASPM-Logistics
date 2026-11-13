-- 工单作业：等待原因、约定时间、紧急、对上院子里的货、不改状态的备注。
-- 在 SQL Editor 整份运行。先有 tickets.sql、workflows.sql、staff.sql。可以重复运行。

alter table public.tickets drop constraint if exists tickets_status_check;
alter table public.tickets add constraint tickets_status_check
  check (status in ('new', 'in_progress', 'waiting', 'done', 'cancelled'));

alter table public.tickets add column if not exists waiting_reason text;
alter table public.tickets drop constraint if exists tickets_waiting_reason_check;
alter table public.tickets add constraint tickets_waiting_reason_check
  check (waiting_reason is null or waiting_reason in ('customer', 'truck', 'paper', 'other'));

alter table public.tickets add column if not exists due_at timestamptz;
alter table public.tickets add column if not exists priority text not null default 'normal';
alter table public.tickets drop constraint if exists tickets_priority_check;
alter table public.tickets add constraint tickets_priority_check
  check (priority in ('normal', 'urgent'));

alter table public.tickets add column if not exists item_id uuid;
alter table public.tickets add column if not exists location_id uuid;
alter table public.tickets add column if not exists facts jsonb not null default '{}'::jsonb;
alter table public.tickets add column if not exists facts_extracted_at timestamptz;
alter table public.tickets add column if not exists facts_confirmed_at timestamptz;
alter table public.tickets add column if not exists facts_confirmed_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tickets_item_id_fkey') then
    alter table public.tickets
      add constraint tickets_item_id_fkey
      foreign key (item_id) references public.items (id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tickets_location_id_fkey') then
    alter table public.tickets
      add constraint tickets_location_id_fkey
      foreign key (location_id) references public.locations (id) on delete set null;
  end if;
end $$;

create index if not exists tickets_due_idx on public.tickets (due_at);

create table if not exists public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  staff_id uuid references public.staff (id) on delete set null,
  author_name text not null default '',
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists ticket_notes_ticket_idx on public.ticket_notes (ticket_id, created_at);

alter table public.ticket_notes enable row level security;
drop policy if exists "ticket notes for authenticated" on public.ticket_notes;
create policy "ticket notes for authenticated"
  on public.ticket_notes for all to authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.ticket_notes to authenticated;

-- 信已经不在邮箱里时，任务池去掉这张单，这里留一份不含原文的档案。
-- 正文和附件不在这里。收到满两年的档案由更新邮件时清掉。
create table if not exists public.ticket_archive (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null,
  archived_at timestamptz not null default now(),
  received_at timestamptz,
  title text not null,
  summary text,
  status text,
  from_name text,
  from_email text,
  customer_name text,
  warehouse_name text,
  assignee_name text,
  waiting_reason text,
  priority text,
  due_at timestamptz,
  closed_at timestamptz,
  message_id text,
  facts jsonb not null default '{}'::jsonb,
  log text not null default ''
);

create unique index if not exists ticket_archive_ticket_uidx on public.ticket_archive (ticket_id);
create index if not exists ticket_archive_received_idx on public.ticket_archive (received_at);

alter table public.ticket_archive enable row level security;
drop policy if exists "ticket archive for authenticated" on public.ticket_archive;
create policy "ticket archive for authenticated"
  on public.ticket_archive for select to authenticated
  using (true);

grant select on public.ticket_archive to authenticated;

-- 文档整理和客户名称。两边都按发件人收录；拖进去的记为手动，改规则时不拿掉。
-- 客户名称可以交给一位同事自动领取。工单上的 has_attachment 只记有没有附件，不参与收录。
create table if not exists public.ticket_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  senders text not null default '',
  titles text not null default '',
  has_attachment boolean not null default false,
  created_by uuid references public.staff (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name)
);

alter table public.ticket_folders add column if not exists has_attachment boolean not null default false;
alter table public.ticket_folders add column if not exists show_unassigned boolean not null default true;
alter table public.ticket_folders drop column if exists files;
alter table public.ticket_folders add column if not exists kind text not null default 'document';
alter table public.ticket_folders drop constraint if exists ticket_folders_kind_check;
alter table public.ticket_folders
  add constraint ticket_folders_kind_check check (kind in ('document', 'customer'));
alter table public.ticket_folders
  add column if not exists claim_staff_id uuid references public.staff (id) on delete set null;

alter table public.ticket_folders drop constraint if exists ticket_folders_name_key;
create unique index if not exists ticket_folders_kind_name_uidx on public.ticket_folders (kind, name);
create index if not exists ticket_folders_created_idx on public.ticket_folders (created_at);
create index if not exists ticket_folders_claim_staff_idx on public.ticket_folders (claim_staff_id);

alter table public.ticket_folders enable row level security;
drop policy if exists "ticket folders for authenticated" on public.ticket_folders;
create policy "ticket folders for authenticated"
  on public.ticket_folders for all to authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.ticket_folders to authenticated;

alter table public.tickets add column if not exists has_attachment boolean;

create table if not exists public.ticket_folder_items (
  folder_id uuid not null references public.ticket_folders (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (folder_id, ticket_id)
);

create index if not exists ticket_folder_items_ticket_idx on public.ticket_folder_items (ticket_id);

alter table public.ticket_folder_items enable row level security;
drop policy if exists "ticket folder items for authenticated" on public.ticket_folder_items;
create policy "ticket folder items for authenticated"
  on public.ticket_folder_items for all to authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.ticket_folder_items to authenticated;

notify pgrst, 'reload schema';
