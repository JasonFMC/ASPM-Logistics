-- 一张任务可以挂多封来往邮件。附件文件不放进这张表，只记名字、大小和类型。
-- 在 supabase/tickets.sql 之后执行。可以重复执行。
-- 已经拆开的旧任务各自留着，每人补一条自己的信，不按标题合并历史。

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  mailbox text,
  message_id text,
  imap_uid bigint,
  from_name text,
  from_email text,
  subject text,
  received_at timestamptz,
  body text,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists ticket_messages_message_id_uidx
  on public.ticket_messages (message_id)
  where message_id is not null;

create unique index if not exists ticket_messages_mailbox_uid_uidx
  on public.ticket_messages (mailbox, imap_uid)
  where imap_uid is not null;

create index if not exists ticket_messages_ticket_idx
  on public.ticket_messages (ticket_id, received_at);

alter table public.tickets add column if not exists mail_count int not null default 0;
alter table public.ticket_messages add column if not exists imap_folder text;
alter table public.ticket_messages add column if not exists to_emails text not null default '';
alter table public.tickets add column if not exists parties text not null default '';
alter table public.tickets add column if not exists filed_folder text;

update public.tickets
set parties = lower(from_email)
where from_email is not null
  and (parties is null or parties = '');

alter table public.ticket_messages enable row level security;

drop policy if exists "ticket messages for authenticated" on public.ticket_messages;
create policy "ticket messages for authenticated"
  on public.ticket_messages for select to authenticated
  using (true);

grant select on public.ticket_messages to authenticated;

insert into public.ticket_messages (
  ticket_id, mailbox, message_id, imap_uid, from_name, from_email, subject, received_at, body, attachments
)
select
  ticket.id,
  ticket.mailbox,
  ticket.message_id,
  ticket.imap_uid,
  ticket.from_name,
  ticket.from_email,
  ticket.title,
  ticket.received_at,
  ticket.summary,
  '[]'::jsonb
from public.tickets as ticket
where ticket.source = 'email'
  and not exists (
    select 1 from public.ticket_messages as message
    where message.ticket_id = ticket.id
       or (ticket.message_id is not null and message.message_id = ticket.message_id)
  );

update public.tickets as ticket
set mail_count = (
  select count(*)::int from public.ticket_messages as message where message.ticket_id = ticket.id
);
