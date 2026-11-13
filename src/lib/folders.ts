import { supabase } from './supabase'

/** 文档整理和客户名称。地址一行一条，对方发来的和我们发给这个地址的都算。都空着时不自动收录。 */
export type FolderKind = 'document' | 'customer'

export interface TicketFolder {
  id: string
  name: string
  kind: FolderKind
  senders: string
  titles: string
  /** 为 false 时，收进这里的任务不出现在未分配栏目。 */
  show_unassigned: boolean
  /** 客户名称交给哪位同事自动领取。文档整理不用。 */
  claim_staff_id: string | null
}

const SELECT = 'id, name, kind, senders, titles, show_unassigned, claim_staff_id'

function errorText(err: unknown) {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object') {
    const row = err as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown }
    return [row.message, row.details, row.hint, row.code].filter((part) => typeof part === 'string' && part).join(' ')
  }
  return ''
}

export function folderSetupHint(err: unknown) {
  const message = errorText(err)
  if (/ticket_folders|show_unassigned|kind|claim_staff_id|schema cache/i.test(message)) {
    return '文档整理和客户名称还没建好。请在 SQL Editor 再运行一次 supabase/ticket_ops.sql。'
  }
  if (/duplicate key|ticket_folders_name|ticket_folders_kind_name/i.test(message)) return '已经有这个名字'
  return message || '没有保存'
}

function asFolder(row: Partial<TicketFolder> & Pick<TicketFolder, 'id' | 'name' | 'senders' | 'titles'>): TicketFolder {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'customer' ? 'customer' : 'document',
    senders: row.senders,
    titles: row.titles,
    show_unassigned: row.show_unassigned !== false,
    claim_staff_id: row.claim_staff_id ?? null,
  }
}

export async function listFolders() {
  const first = await supabase.from('ticket_folders').select(SELECT).order('created_at')
  if (!first.error) return ((first.data ?? []) as TicketFolder[]).map((row) => asFolder(row))
  if (!/kind|claim_staff_id|show_unassigned/i.test(first.error.message)) throw first.error
  const second = await supabase.from('ticket_folders').select('id, name, senders, titles, show_unassigned').order('created_at')
  if (second.error && /show_unassigned/i.test(second.error.message)) {
    const third = await supabase.from('ticket_folders').select('id, name, senders, titles').order('created_at')
    if (third.error) throw third.error
    return ((third.data ?? []) as Array<Pick<TicketFolder, 'id' | 'name' | 'senders' | 'titles'>>).map((row) => asFolder(row))
  }
  if (second.error) throw second.error
  return ((second.data ?? []) as Array<Pick<TicketFolder, 'id' | 'name' | 'senders' | 'titles' | 'show_unassigned'>>).map((row) =>
    asFolder(row),
  )
}

export async function createFolder(name: string, staffId: string | null, kind: FolderKind) {
  const { data, error } = await supabase
    .from('ticket_folders')
    .insert({ name: name.trim(), created_by: staffId, kind })
    .select(SELECT)
    .single()
  if (error) throw error
  return asFolder(data as TicketFolder)
}

export async function saveFolder(
  id: string,
  patch: Pick<TicketFolder, 'name' | 'senders' | 'titles' | 'show_unassigned'>,
) {
  const { error } = await supabase
    .from('ticket_folders')
    .update({ ...patch, name: patch.name.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw error
}

export async function removeFolder(id: string) {
  const { error } = await supabase.from('ticket_folders').delete().eq('id', id)
  if (error) throw error
}

export interface FolderMembership {
  folder_id: string
  ticket_id: string
  manual: boolean
  title: string
  status: string
}

interface RuleTicket {
  id: string
  from_email: string | null
  parties: string | null
  status: string
}

function ruleLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function bareAddress(value: string) {
  const wrapped = value.match(/<([^<>]+@[^<>]+)>/)
  return (wrapped?.[1] ?? value).trim().toLowerCase()
}

function senderMatches(email: string | null, rules: string[]) {
  if (!rules.length) return true
  if (!email) return false
  const lower = bareAddress(email)
  if (!lower.includes('@')) return false
  const domain = lower.slice(lower.lastIndexOf('@') + 1)
  return rules.some((rule) => {
    const needle = bareAddress(rule).replace(/^@/, '')
    if (!needle) return false
    if (needle.includes('@')) return lower === needle
    return domain === needle
  })
}

/** 客户地址对上发件人或收件人都收录。没填地址时不收录。 */
export function folderMatches(folder: Pick<TicketFolder, 'senders'>, ticket: RuleTicket) {
  if (ticket.status === 'done') return false
  const senders = ruleLines(folder.senders)
  if (!senders.length) return false
  const addresses = [ticket.from_email, ...ruleLines(ticket.parties || '')]
  return addresses.some((email) => senderMatches(email, senders))
}

async function listRuleTickets() {
  const rows: RuleTicket[] = []
  let columns = 'id, from_email, parties, status'
  for (let from = 0; ; from += 1000) {
    let page = await supabase.from('tickets').select(columns).order('id').range(from, from + 999)
    if (page.error && columns.includes('parties') && /parties|schema cache/i.test(errorText(page.error))) {
      columns = 'id, from_email, status'
      page = await supabase.from('tickets').select(columns).order('id').range(from, from + 999)
    }
    if (page.error) throw page.error
    rows.push(
      ...((page.data ?? []) as unknown as Array<RuleTicket & { parties?: string | null }>).map((row) => ({
        id: row.id,
        from_email: row.from_email,
        parties: row.parties ?? null,
        status: row.status,
      })),
    )
    if ((page.data ?? []).length < 1000) break
  }
  return rows
}

export async function listMemberships() {
  const rows: FolderMembership[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('ticket_folder_items')
      .select('folder_id, ticket_id, manual, tickets(title, status)')
      .order('created_at')
      .range(from, from + 999)
    if (error) throw error
    for (const row of data ?? []) {
      const ticket = row.tickets as { title?: string; status?: string } | { title?: string; status?: string }[] | null
      const one = Array.isArray(ticket) ? ticket[0] : ticket
      rows.push({
        folder_id: String(row.folder_id),
        ticket_id: String(row.ticket_id),
        manual: Boolean(row.manual),
        title: one?.title ?? '',
        status: one?.status ?? '',
      })
    }
    if ((data ?? []).length < 1000) break
  }
  return rows
}

export async function placeInFolder(folderId: string, ticketId: string) {
  const { error } = await supabase
    .from('ticket_folder_items')
    .upsert({ folder_id: folderId, ticket_id: ticketId, manual: true }, { onConflict: 'folder_id,ticket_id' })
  if (error) throw error
}

export async function removeFromFolder(folderId: string, ticketId: string) {
  const { error } = await supabase.from('ticket_folder_items').delete().eq('folder_id', folderId).eq('ticket_id', ticketId)
  if (error) throw error
}

async function listFolderItems(folderId: string) {
  const rows: Array<{ ticket_id: string; manual: boolean }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('ticket_folder_items')
      .select('ticket_id, manual')
      .eq('folder_id', folderId)
      .order('ticket_id')
      .range(from, from + 999)
    if (error) throw error
    rows.push(...((data ?? []) as Array<{ ticket_id: string; manual: boolean }>))
    if ((data ?? []).length < 1000) break
  }
  return rows
}

/** 按当前规则重收这一夹。手动拖进去的留着。 */
export async function applyFolder(folder: TicketFolder, tickets?: RuleTicket[]) {
  const rows = tickets ?? (await listRuleTickets())
  const wanted = new Set(rows.filter((ticket) => folderMatches(folder, ticket)).map((ticket) => ticket.id))
  const existing = await listFolderItems(folder.id)
  const have = new Set(existing.map((row) => row.ticket_id))
  const drop = existing.filter((row) => !row.manual && !wanted.has(row.ticket_id)).map((row) => row.ticket_id)
  const add = [...wanted].filter((id) => !have.has(id))
  for (let start = 0; start < drop.length; start += 100) {
    const slice = drop.slice(start, start + 100)
    const removed = await supabase
      .from('ticket_folder_items')
      .delete()
      .eq('folder_id', folder.id)
      .eq('manual', false)
      .in('ticket_id', slice)
    if (removed.error) throw removed.error
  }
  for (let start = 0; start < add.length; start += 100) {
    const slice = add.slice(start, start + 100).map((ticketId) => ({
      folder_id: folder.id,
      ticket_id: ticketId,
      manual: false,
    }))
    const inserted = await supabase.from('ticket_folder_items').insert(slice)
    if (inserted.error) throw inserted.error
  }
}

export async function applyAllFolders() {
  const [folders, tickets] = await Promise.all([listFolders(), listRuleTickets()])
  let firstError: unknown = null
  for (const folder of folders) {
    try {
      await applyFolder(folder, tickets)
    } catch (err) {
      firstError ??= err
    }
  }
  if (firstError) throw firstError
}
