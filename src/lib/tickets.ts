import { supabase } from './supabase'
import type {
  StageAlert,
  Ticket,
  TicketBatch,
  TicketEvent,
  TicketFacts,
  TicketNote,
  TicketPriority,
  TicketStage,
  TicketStatus,
  WaitingReason,
  Warehouse,
  Workflow,
} from './types'

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  new: '待处理',
  in_progress: '处理中',
  waiting: '等待',
  done: '已完成',
  cancelled: '已取消',
}

export const WAITING_REASON_LABEL: Record<WaitingReason, string> = {
  customer: '等客户',
  truck: '等车',
  paper: '等单据',
  other: '其他',
}

export function ticketOpsHint(message: string) {
  if (/due_at|waiting_reason|ticket_notes|priority|item_id|location_id|facts_confirmed/i.test(message)) {
    return '工单表还是旧的。请在 Supabase SQL Editor 运行 supabase/ticket_ops.sql。'
  }
  return null
}

export const TICKET_SOURCE_LABEL = {
  email: '邮件',
  manual: '手动',
} as const

const TICKET_SELECT = '*, warehouses(id, name), customers(id, name), assignee:staff!tickets_claimed_by_fkey(id, display_name, hue)'

export type TicketListStatus = TicketStatus | 'open' | 'all'

export interface TicketFilter {
  status?: TicketListStatus
  batch?: TicketBatch
  warehouseId?: string | 'all'
}

function compareTickets(a: Ticket, b: Ticket) {
  const urgentA = a.priority === 'urgent' ? 0 : 1
  const urgentB = b.priority === 'urgent' ? 0 : 1
  if (urgentA !== urgentB) return urgentA - urgentB
  const dueA = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY
  const dueB = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY
  if (dueA !== dueB) return dueA - dueB
  const recA = Date.parse(a.received_at || a.created_at)
  const recB = Date.parse(b.received_at || b.created_at)
  return recB - recA
}

export async function listWarehouses() {
  const { data, error } = await supabase
    .from('warehouses')
    .select('*')
    .eq('archived', false)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data ?? []) as Warehouse[]
}

export async function renameWarehouse(id: string, name: string) {
  const next = name.trim()
  if (!next) throw new Error('请填写仓库名')
  const { data, error } = await supabase
    .from('warehouses')
    .update({ name: next })
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data as Warehouse
}

export async function listTickets(filter: TicketFilter = {}) {
  let query = supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .order('received_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(200)

  if (filter.status === 'open') query = query.not('status', 'in', '(done,cancelled)')
  else if (filter.status && filter.status !== 'all') query = query.eq('status', filter.status)
  if (filter.batch) query = query.eq('batch', filter.batch)
  if (filter.warehouseId && filter.warehouseId !== 'all') {
    query = query.eq('warehouse_id', filter.warehouseId)
  }

  const { data, error } = await query
  if (error) throw error
  return ((data ?? []) as Ticket[]).sort(compareTickets)
}

export async function getTicket(id: string) {
  const { data, error } = await supabase
    .from('tickets')
    .select(TICKET_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return (data as Ticket | null) ?? null
}

export async function listTicketEvents(ticketId: string) {
  const { data, error } = await supabase
    .from('ticket_events')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as TicketEvent[]
}

export async function createManualTicket(input: {
  title: string
  summary?: string
  warehouseId?: string | null
}) {
  const title = input.title.trim()
  if (!title) throw new Error('请填写标题')

  const { data: session } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('tickets')
    .insert({
      title,
      summary: input.summary?.trim() || null,
      source: 'manual',
      status: 'new',
      batch: 'live',
      warehouse_id: input.warehouseId ?? null,
    })
    .select(TICKET_SELECT)
    .single()
  if (error) throw error

  const ticket = data as Ticket
  await supabase.from('ticket_events').insert({
    ticket_id: ticket.id,
    from_status: null,
    to_status: 'new',
    actor_id: session.user?.id ?? null,
    note: '手动新建',
  })
  return ticket
}

/** Desktop Outlook on this PC. A browser cannot open one IMAP message inside Outlook. */
export function originalMailUrl(ticket: Pick<Ticket, 'message_id'>): string | null {
  const id = ticket.message_id?.trim()
  if (!id) return null
  return `aspm-mail:${encodeURIComponent(id)}`
}

export async function setTicketStatus(
  ticket: Ticket,
  status: TicketStatus,
  options?: { note?: string; reason?: WaitingReason },
) {
  if (ticket.status === status && (status !== 'waiting' || ticket.waiting_reason === options?.reason)) {
    return ticket
  }
  if (status === 'waiting' && !options?.reason) throw new Error('请选择等待原因')

  const stages = await listTicketStages(ticket.id)
  const open = stages.some((row) => row.status === 'pending' || row.status === 'active' || row.status === 'waiting')
  if (status === 'done' && open) throw new Error('还有环节没做完')
  if (status === 'new' && stages.length > 0) throw new Error('这张单已经在流程里，请按环节推进')

  const now = new Date().toISOString()
  if (status === 'waiting') {
    const current = stages.find((row) => row.status === 'active')
    if (current) {
      const { error } = await supabase
        .from('ticket_stages')
        .update({ status: 'waiting', updated_at: now })
        .eq('id', current.id)
      if (error) throw error
    }
  }
  let openedWaiting = false
  if (status === 'in_progress') {
    const paused = stages.find((row) => row.status === 'waiting')
    const active = stages.find((row) => row.status === 'active')
    const pending = stages.find((row) => row.status === 'pending')
    const last = [...stages].reverse().find((row) => row.status === 'done' || row.status === 'skipped')
    const target = !active ? (paused ?? pending ?? last ?? null) : null
    if (target) {
      const stageStatus = target.kind === 'wait_external' && target.status === 'pending' ? 'waiting' : 'active'
      openedWaiting = stageStatus === 'waiting'
      const { error } = await supabase
        .from('ticket_stages')
        .update({
          status: stageStatus,
          started_at: target.started_at ?? now,
          completed_at: null,
          updated_at: now,
        })
        .eq('id', target.id)
      if (error) throw error
    }
  }

  const resolved: TicketStatus = openedWaiting ? 'waiting' : status
  const patch = {
    status: resolved,
    updated_at: now,
    waiting_reason: resolved === 'waiting' ? (options?.reason ?? ticket.waiting_reason ?? null) : null,
    closed_at: resolved === 'done' || resolved === 'cancelled' ? now : null,
  }
  const { data, error } = await supabase.from('tickets').update(patch).eq('id', ticket.id).select(TICKET_SELECT).single()
  if (error) throw error

  const { data: session } = await supabase.auth.getUser()
  const reasonNote = resolved === 'waiting' && options?.reason ? WAITING_REASON_LABEL[options.reason] : null
  await supabase.from('ticket_events').insert({
    ticket_id: ticket.id,
    from_status: ticket.status,
    to_status: resolved,
    actor_id: session.user?.id ?? null,
    note: options?.note ?? reasonNote,
  })
  return data as Ticket
}

/** 分到别的仓，例如 36 号仓接的活。 */
export async function setTicketWarehouse(ticketId: string, warehouseId: string | null) {
  const { data, error } = await supabase
    .from('tickets')
    .update({ warehouse_id: warehouseId, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .select(TICKET_SELECT)
    .single()
  if (error) throw error
  return data as Ticket
}

export async function saveTicketJob(
  ticketId: string,
  input: { facts: TicketFacts; dueAt: string | null; priority: TicketPriority; confirm: boolean },
) {
  const facts: TicketFacts = {
    reference: input.facts.reference?.trim() || undefined,
    qty: input.facts.qty?.trim() || undefined,
    note: input.facts.note?.trim() || undefined,
  }
  const hasFact = Boolean(facts.reference || facts.qty || facts.note || input.dueAt)
  if (input.confirm && !hasFact) throw new Error('先写上单号、数量、约定时间或备注')

  const { data: session } = await supabase.auth.getUser()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('tickets')
    .update({
      facts,
      due_at: input.dueAt,
      priority: input.priority,
      facts_confirmed_at: input.confirm ? now : null,
      facts_confirmed_by: input.confirm ? (session.user?.id ?? null) : null,
      updated_at: now,
    })
    .eq('id', ticketId)
    .select(TICKET_SELECT)
    .single()
  if (error) throw error
  return data as Ticket
}

export async function setTicketTarget(ticketId: string, itemId: string | null, locationId: string | null) {
  const { data, error } = await supabase
    .from('tickets')
    .update({ item_id: itemId, location_id: locationId, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
    .select(TICKET_SELECT)
    .single()
  if (error) throw error
  return data as Ticket
}

export async function describeTarget(ticket: Pick<Ticket, 'item_id' | 'location_id'>) {
  const item = ticket.item_id
    ? await supabase.from('items').select('id, code, name, location_id').eq('id', ticket.item_id).maybeSingle()
    : { data: null, error: null }
  const place = ticket.location_id
    ? await supabase.from('locations').select('id, code, label').eq('id', ticket.location_id).maybeSingle()
    : { data: null, error: null }
  if (item.error) throw item.error
  if (place.error) throw place.error
  return {
    item: item.data as { id: string; code: string; name: string | null; location_id: string | null } | null,
    place: place.data as { id: string; code: string; label: string | null } | null,
  }
}

export async function searchYard(query: string) {
  const q = query.trim().replace(/[%_,.()]/g, '')
  if (!q) return { items: [] as YardItemHit[], locations: [] as YardPlaceHit[] }
  const pattern = `%${q}%`
  const [items, locations] = await Promise.all([
    supabase.from('items').select('id, code, name, location_id').or(`code.ilike.${pattern},name.ilike.${pattern}`).limit(8),
    supabase.from('locations').select('id, code, label').or(`code.ilike.${pattern},label.ilike.${pattern}`).limit(8),
  ])
  if (items.error) throw items.error
  if (locations.error) throw locations.error
  return {
    items: (items.data ?? []) as YardItemHit[],
    locations: (locations.data ?? []) as YardPlaceHit[],
  }
}

export interface YardItemHit {
  id: string
  code: string
  name: string | null
  location_id: string | null
}

export interface YardPlaceHit {
  id: string
  code: string
  label: string | null
}

export async function listTicketNotes(ticketId: string) {
  const { data, error } = await supabase
    .from('ticket_notes')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as TicketNote[]
}

export async function addTicketNote(ticketId: string, body: string, staffId: string | null, authorName: string) {
  const text = body.trim()
  if (!text) throw new Error('请写备注')
  if (text.length > 500) throw new Error('备注请写在 500 字以内')
  const { error } = await supabase.from('ticket_notes').insert({
    ticket_id: ticketId,
    staff_id: staffId,
    author_name: authorName,
    body: text,
  })
  if (error) throw error
}

/** 把这个发件人加进客户白名单，以后同域来信自动归到这个仓。 */
export async function addSenderToWhitelist(ticket: Ticket, customerName: string) {
  const name = customerName.trim()
  const email = ticket.from_email?.trim().toLowerCase()
  if (!name) throw new Error('请填写客户名')
  if (!email) throw new Error('这封没有发件人地址，不能加白名单')

  const { data: existing } = await supabase
    .from('customers')
    .select('*')
    .eq('name', name)
    .maybeSingle()

  let customerId = existing?.id as string | undefined
  if (!customerId) {
    const { data, error } = await supabase
      .from('customers')
      .insert({ name, warehouse_id: ticket.warehouse_id })
      .select('id')
      .single()
    if (error) throw error
    customerId = data.id as string
  }

  const { error: senderError } = await supabase
    .from('customer_senders')
    .upsert({ customer_id: customerId, pattern: email }, { onConflict: 'pattern' })
  if (senderError) throw senderError

  const { data, error } = await supabase
    .from('tickets')
    .update({ customer_id: customerId, is_new_sender: false, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
    .select(TICKET_SELECT)
    .single()
  if (error) throw error
  return data as Ticket
}

export async function listWorkflows() {
  const { data, error } = await supabase
    .from('workflows')
    .select('id, name, description')
    .eq('archived', false)
    .order('name')
  if (error) throw error
  return (data ?? []) as Workflow[]
}

export async function listStageAlerts() {
  const { data, error } = await supabase
    .from('v_stage_alerts')
    .select(
      'stage_id, ticket_id, stage_name, stage_status, started_at, remind_note, stuck_for, overdue_by, title, ticket_status, warehouse_id',
    )
    .order('overdue_by', { ascending: false })
  if (error) throw error
  return (data ?? []) as StageAlert[]
}

export async function listTicketStages(ticketId: string) {
  const { data, error } = await supabase
    .from('ticket_stages')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('sort_order')
  if (error) throw error
  return (data ?? []) as TicketStage[]
}

/** 把流程模板复印到这张工单上。已经有环节的单不再套第二次。 */
export async function applyWorkflow(ticketId: string, workflowId: string) {
  const existing = await listTicketStages(ticketId)
  if (existing.length > 0) throw new Error('这张单已经有流程了')

  const { data: version, error: versionError } = await supabase
    .from('workflow_versions')
    .select('id')
    .eq('workflow_id', workflowId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (versionError) throw versionError
  if (!version) throw new Error('这条流程还没有步骤')

  const { data: steps, error: stepError } = await supabase
    .from('workflow_steps')
    .select('step_key, name, description, sort_order, kind, optional, remind_after, remind_note')
    .eq('version_id', version.id)
    .order('sort_order')
  if (stepError) throw stepError
  if (!steps?.length) throw new Error('这条流程还没有步骤')

  const now = new Date().toISOString()
  const rows = steps.map((step, index) => ({
    ticket_id: ticketId,
    step_key: step.step_key,
    name: step.name,
    description: step.description,
    sort_order: step.sort_order,
    kind: step.kind,
    optional: step.optional,
    remind_after: step.remind_after,
    remind_note: step.remind_note,
    status: index === 0 ? (step.kind === 'wait_external' ? 'waiting' : 'active') : 'pending',
    started_at: index === 0 ? now : null,
  }))

  const { error: insertError } = await supabase.from('ticket_stages').insert(rows)
  if (insertError) throw insertError

  const firstWaiting = rows[0]?.status === 'waiting'
  const { data: current } = await supabase.from('tickets').select('status').eq('id', ticketId).maybeSingle()
  const { error: ticketError } = await supabase
    .from('tickets')
    .update({
      workflow_id: workflowId,
      workflow_version_id: version.id,
      status: firstWaiting ? 'waiting' : 'in_progress',
      updated_at: now,
    })
    .eq('id', ticketId)
  if (ticketError) throw ticketError

  const { data: session } = await supabase.auth.getUser()
  await supabase.from('ticket_events').insert({
    ticket_id: ticketId,
    from_status: (current?.status as TicketStatus | undefined) ?? null,
    to_status: firstWaiting ? 'waiting' : 'in_progress',
    actor_id: session.user?.id ?? null,
    note: '套用流程',
  })
}

/** 结束当前环节，并让下一步开始计时。 */
export async function finishStage(stage: TicketStage, outcome: 'done' | 'skipped') {
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('ticket_stages')
    .update({ status: outcome, completed_at: now, updated_at: now })
    .eq('id', stage.id)
  if (error) throw error

  const stages = await listTicketStages(stage.ticket_id)
  const next = stages.find((row) => row.sort_order > stage.sort_order && row.status === 'pending')
  if (next) {
    const { error: nextError } = await supabase
      .from('ticket_stages')
      .update({
        status: next.kind === 'wait_external' ? 'waiting' : 'active',
        started_at: now,
        updated_at: now,
      })
      .eq('id', next.id)
    if (nextError) throw nextError
  }
  await syncStatusFromStages(stage.ticket_id)
}

/** 工单状态跟着还没做完的环节走。取消过的单不再被环节改回去。 */
async function syncStatusFromStages(ticketId: string) {
  const stages = await listTicketStages(ticketId)
  const { data: current, error: readError } = await supabase
    .from('tickets')
    .select('status')
    .eq('id', ticketId)
    .maybeSingle()
  if (readError) throw readError
  if (!current || current.status === 'cancelled') return

  const active = stages.find((row) => row.status === 'active')
  const waiting = stages.find((row) => row.status === 'waiting')
  const pending = stages.find((row) => row.status === 'pending')
  let next: TicketStatus = 'done'
  if (active) next = 'in_progress'
  else if (waiting) next = 'waiting'
  else if (pending) next = 'in_progress'
  if (current.status === next) return

  const now = new Date().toISOString()
  const patch: { status: TicketStatus; updated_at: string; closed_at: string | null; waiting_reason?: null } = {
    status: next,
    updated_at: now,
    closed_at: next === 'done' ? now : null,
  }
  if (next !== 'waiting') patch.waiting_reason = null
  const { error } = await supabase.from('tickets').update(patch).eq('id', ticketId)
  if (error) throw error

  const { data: session } = await supabase.auth.getUser()
  await supabase.from('ticket_events').insert({
    ticket_id: ticketId,
    from_status: current.status as TicketStatus,
    to_status: next,
    actor_id: session.user?.id ?? null,
    note: '跟着环节更新',
  })
}

export interface PullResult {
  scanned: number
  inserted: number
  skipped: number
  newSenders: number
  updated?: number
  mailbox?: string
  lastUid?: number
  mailboxMaxUid?: number
  pending?: number
}

export interface PullProgress {
  pct: number
  step: string
  detail?: string
}

/** 拉取新邮件进度条上的步骤。「写入工单」从 30% 走到 95%，按已处理的封数推进。 */
export const PULL_STEPS = [
  { pct: 10, step: '已接到请求' },
  { pct: 20, step: '连上邮箱' },
  { pct: 30, step: '找到新信' },
  { pct: 31, step: '写入工单' },
  { pct: 100, step: '完成' },
]

interface PullFrame extends Partial<PullResult> {
  pct?: number
  step?: string
  detail?: string
  result?: PullResult
  error?: string
}

/** mail-sync 每做完一步回一行 JSON，最后一行是结果或错误。 */
export async function pullMail(onProgress: (update: PullProgress) => void = () => undefined) {
  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!token || !supabaseUrl || !anonKey) throw new Error('未登录')

  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/mail-sync`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'Content-Type': 'application/json' },
      body: '{}',
    })
  } catch {
    throw new Error('浏览器没有连上拉信服务，请检查网络后再点一次。')
  }
  if (!response.ok) {
    const text = (await response.text()).trim()
    let message = text
    try {
      const payload = JSON.parse(text) as { error?: string; message?: string; msg?: string }
      message = payload.error || payload.message || payload.msg || text
    } catch {
      // 不是 JSON 时就用原文
    }
    throw new Error(`拉信服务回复 ${response.status}：${message || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('拉信服务没有回复内容')
  const decoder = new TextDecoder()
  let pending = ''
  let lastStep = '正在送出请求'
  let result: PullResult | null = null

  const handle = (line: string) => {
    const text = line.trim()
    if (!text) return
    const frame = JSON.parse(text) as PullFrame
    if (frame.error) throw new Error(frame.error)
    if (typeof frame.pct === 'number' && frame.step) {
      lastStep = frame.step
      onProgress({ pct: frame.pct, step: frame.step, detail: frame.detail })
    }
    if (frame.result) result = frame.result
    else if (typeof frame.scanned === 'number') {
      result = {
        scanned: frame.scanned,
        inserted: frame.inserted ?? 0,
        skipped: frame.skipped ?? 0,
        newSenders: frame.newSenders ?? 0,
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      handle(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  }
  handle(pending + decoder.decode())
  if (!result) throw new Error(`读到「${lastStep}」后拉信服务断开了，没有说明原因。`)
  return result as PullResult
}

export function missingTicketsTable(message: string) {
  return /tickets|warehouses|schema cache|does not exist/i.test(message)
}
