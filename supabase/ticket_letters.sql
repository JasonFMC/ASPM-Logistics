-- 原信正文只留两周。附件不放进这张表。
-- 在 supabase/tickets.sql 之后执行。可以重复执行。

create table if not exists public.ticket_letters (
  ticket_id uuid primary key references public.tickets (id) on delete cascade,
  payload jsonb not null,
  expires_at timestamptz not null
);

create index if not exists ticket_letters_expires_idx
  on public.ticket_letters (expires_at);

alter table public.ticket_letters enable row level security;

drop policy if exists "ticket_letters_select_auth" on public.ticket_letters;
create policy "ticket_letters_select_auth"
  on public.ticket_letters
  for select
  to authenticated
  using (true);
