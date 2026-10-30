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

notify pgrst, 'reload schema';
