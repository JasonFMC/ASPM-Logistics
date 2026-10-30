// 从任务邮箱拉新信建工单。只把工单字段写进库，原信留在邮箱里，附件和正文全文不入库。
// 邮箱以只读方式打开，不会把邮件标成已读。
//
// 流程：每次请求重新登录任务邮箱（不保持连接）→ 只读打开收件箱 →
// 按到达时间找出 2026-10-19（本周一，澳洲东部）0 点之后的信 → 每 50 封一批：
// 没建过单的，取开头 16 KB 建单。Message-ID 对得上的，改原工单的标题、摘要和 UID，不另建。
// UID 没变的，只读信头；标题变了再取开头 16 KB，改标题和摘要，清掉原信缓存。状态、仓库、客户和流程不动。
// 邮箱连接用 Deno 自带的 TLS 和下面的最小 IMAP 客户端，不用 imapflow：
// imapflow 在 Edge Runtime 的 Node 兼容 TLS 上收不完长回复。
//
// 回复是一行一个 JSON：每做完一步送 {pct, step, detail?}，最后送 {result} 或 {error}。
// 页面按这些行走进度条。登录前就能判断的错误（未登录、没配 Secrets）照旧用 JSON 和状态码回。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import PostalMime, { type Address, type Email } from 'npm:postal-mime@4'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/**
 * 从这一刻起收信，更早的不建单。
 * 澳洲东部时间 2026-10-19 周一 00:00。书签如果停在周中，这一天之后漏掉的信也会补上。
 */
const CATCHUP_SINCE = '2026-10-19T00:00:00+11:00'
/** 一次点击最多新建这么多张，避免函数超时。没建完会提示再点一次。 */
const MAX_PER_RUN = 200
const BATCH = 50
/** 每封信只取开头这么多字节，够拆出信头和摘要。 */
const HEAD_BYTES = 16_384
const SUMMARY_CHARS = 400

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function messageOf(err: unknown) {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return '拉取失败'
}

interface PullResult {
  scanned: number
  inserted: number
  skipped: number
  newSenders: number
  updated: number
  mailbox: string
  lastUid: number
  mailboxMaxUid: number
  pending: number
}

interface Frame {
  pct?: number
  step?: string
  detail?: string
  result?: PullResult
  error?: string
}

type Report = (pct: number, step: string, detail?: string) => void

/** 一行太短会被网关攒着不发。补到 4 KB，页面才能立刻看到这一步。 */
const FRAME_PAD = 4096

function frameResponse(run: (report: Report) => Promise<PullResult>) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const send = (frame: Frame) => {
        if (!open) return
        try {
          const line = JSON.stringify(frame)
          const pad = line.length < FRAME_PAD ? ' '.repeat(FRAME_PAD - line.length) : ''
          controller.enqueue(encoder.encode(`${line}${pad}\n`))
        } catch {
          open = false
        }
      }
      run((pct, step, detail) => send({ pct, step, detail }))
        .then((result) => send({ pct: 100, step: '完成', result }))
        .catch((err: unknown) => send({ error: messageOf(err) }))
        .finally(() => {
          open = false
          try {
            controller.close()
          } catch {
            // 页面已经断开
          }
        })
    },
  })
  return new Response(stream, {
    headers: {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  })
}

/** 新项目注入 SUPABASE_*_KEYS（JSON），老项目注入单个 key。两种都认。 */
function platformKey(single: string, dictionary: string) {
  const direct = Deno.env.get(single)
  if (direct) return direct
  const raw = Deno.env.get(dictionary)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return parsed.default ?? Object.values(parsed)[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 最小 IMAP 客户端：LOGIN、EXAMINE（只读打开）、UID SEARCH、UID FETCH、LOGOUT。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 连上以后，邮箱多久一个字节都不发就算断了。 */
const IDLE_MS = 30_000
const CONNECT_MS = 15_000

type Part = string | { literal: Uint8Array }

interface Reply {
  text: string
  literals: Uint8Array[]
}

function astring(value: string): Part {
  if (/^[\x20-\x7e]*$/.test(value)) return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`
  return { literal: encoder.encode(value) }
}

function findLineEnd(bytes: Uint8Array) {
  for (let index = 0; index + 1 < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index
  }
  return -1
}

function concat(a: Uint8Array, b: Uint8Array) {
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a)
  joined.set(b, a.length)
  return joined
}

function waitFor<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error(message))
    }, ms)
  })
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
}

class MailboxRefused extends Error {}

class Imap {
  private buffer: Uint8Array = new Uint8Array(0)
  private tag = 0

  private constructor(private readonly conn: Deno.Conn) {}

  static async open(host: string, port: number) {
    const connecting: Promise<Deno.Conn> =
      port === 993 ? Deno.connectTls({ hostname: host, port }) : Deno.connect({ hostname: host, port })
    const conn = await waitFor(connecting, CONNECT_MS, `连不上邮箱服务器 ${host}:${port}`)
    const client = new Imap(conn)
    const greeting = await client.readLine()
    if (!/^\* (OK|PREAUTH)/i.test(greeting)) {
      client.close()
      throw new Error(`邮箱服务器没有正常应答：${greeting.slice(0, 120)}`)
    }
    return client
  }

  async login(user: string, pass: string) {
    try {
      await this.run(['LOGIN ', astring(user), ' ', astring(pass)])
    } catch (err) {
      if (err instanceof MailboxRefused) throw new Error('邮箱拒绝登录，请检查 IMAP_USER / IMAP_PASSWORD')
      throw err
    }
  }

  /** 只读打开文件夹，返回 UIDVALIDITY。 */
  async examine(folder: string) {
    const replies = await this.run(['EXAMINE ', astring(folder)])
    for (const reply of replies) {
      const match = reply.text.match(/UIDVALIDITY (\d+)/i)
      if (match) return Number(match[1])
    }
    return 0
  }

  /** 收件箱里现在最大的 UID。没有信时是 0。 */
  async mailboxUid() {
    const replies = await this.run(['UID FETCH * (UID)'])
    let max = 0
    for (const reply of replies) {
      const uid = Number(reply.text.match(/\bUID (\d+)/i)?.[1] ?? 0)
      if (uid > max) max = uid
    }
    return max
  }

  /** 只取 UID 和到达时间，不取正文。从最新往回翻，直到整段都早于 since。 */
  async arrivedSince(sinceIso: string) {
    const since = Date.parse(sinceIso)
    const max = await this.mailboxUid()
    const kept: number[] = []
    if (!max || Number.isNaN(since)) return { max, uids: kept, truncated: false }
    const window = 200
    const maxWindows = 40
    let truncated = false
    for (let step = 0; step < maxWindows; step += 1) {
      const end = max - step * window
      if (end < 1) break
      const start = Math.max(1, end - window + 1)
      const replies = await this.run([`UID FETCH ${start}:${end} (UID INTERNALDATE)`])
      const rows: Array<{ uid: number; arrived: number | null }> = []
      for (const reply of replies) {
        if (!/^\* \d+ FETCH/i.test(reply.text)) continue
        const uid = Number(reply.text.match(/\bUID (\d+)/i)?.[1] ?? 0)
        if (!uid) continue
        const arrived = parseInternalDate(reply.text)
        rows.push({ uid, arrived: arrived ? Date.parse(arrived) : null })
      }
      for (const row of rows) {
        if (row.arrived !== null && !Number.isNaN(row.arrived) && row.arrived >= since) kept.push(row.uid)
      }
      const dated = rows.filter((row) => row.arrived !== null && !Number.isNaN(row.arrived))
      if (dated.length > 0 && dated.every((row) => (row.arrived ?? 0) < since)) break
      if (start === 1) break
      if (step === maxWindows - 1) truncated = true
    }
    kept.sort((a, b) => a - b)
    return { max, uids: kept, truncated }
  }

  /** 只取信头，用来看标题有没有变。 */
  async headers(uids: number[]) {
    if (!uids.length) return new Map<number, Uint8Array>()
    const replies = await this.run([`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER])`])
    const found = new Map<number, Uint8Array>()
    for (const reply of replies) {
      if (!/^\* \d+ FETCH/i.test(reply.text)) continue
      const uid = reply.text.match(/\bUID (\d+)/i)
      if (!uid || !reply.literals.length) continue
      found.set(Number(uid[1]), reply.literals[0])
    }
    return found
  }

  /** 一条命令取回这批信每封开头 bytes 个字节，以及邮箱记下的到达时间。 */
  async heads(uids: number[], bytes: number) {
    const replies = await this.run([
      `UID FETCH ${uids.join(',')} (UID INTERNALDATE BODY.PEEK[]<0.${bytes}>)`,
    ])
    const found = new Map<number, { bytes: Uint8Array; arrived: string | null }>()
    for (const reply of replies) {
      if (!/^\* \d+ FETCH/i.test(reply.text)) continue
      const uid = reply.text.match(/\bUID (\d+)/i)
      if (!uid || !reply.literals.length) continue
      found.set(Number(uid[1]), { bytes: reply.literals[0], arrived: parseInternalDate(reply.text) })
    }
    return found
  }

  async logout() {
    try {
      await waitFor(this.run(['LOGOUT']), 3_000, '退出超时')
    } catch {
      // 退出失败不影响已经建好的工单
    } finally {
      this.close()
    }
  }

  close() {
    try {
      this.conn.close()
    } catch {
      // 已经关掉
    }
  }

  private async write(bytes: Uint8Array) {
    let written = 0
    while (written < bytes.length) {
      written += await waitFor(this.conn.write(bytes.subarray(written)), IDLE_MS, '向邮箱发命令超时')
    }
  }

  private async more() {
    const chunk = new Uint8Array(64 * 1024)
    const count = await waitFor(this.conn.read(chunk), IDLE_MS, `邮箱 ${IDLE_MS / 1000} 秒没有传数据`, () =>
      this.close(),
    )
    if (count === null) throw new Error('邮箱断开了连接')
    return chunk.subarray(0, count)
  }

  private async readLine() {
    while (true) {
      const end = findLineEnd(this.buffer)
      if (end >= 0) {
        const line = decoder.decode(this.buffer.subarray(0, end))
        this.buffer = this.buffer.slice(end + 2)
        return line
      }
      this.buffer = concat(this.buffer, await this.more())
    }
  }

  private async readExact(size: number) {
    while (this.buffer.length < size) this.buffer = concat(this.buffer, await this.more())
    const out = this.buffer.slice(0, size)
    this.buffer = this.buffer.slice(size)
    return out
  }

  /** 发一条命令，读到这条命令的完成行为止。返回期间收到的其它行，行里的大段内容放在 literals。 */
  private async run(parts: Part[]) {
    this.tag += 1
    const tag = `A${this.tag}`
    let pending = `${tag} `
    for (const part of parts) {
      if (typeof part === 'string') {
        pending += part
        continue
      }
      await this.write(encoder.encode(`${pending}{${part.literal.length}}\r\n`))
      pending = ''
      const go = await this.readLine()
      if (!go.startsWith('+')) throw new MailboxRefused(`邮箱不接受这条命令：${go.slice(0, 120)}`)
      await this.write(part.literal)
    }
    await this.write(encoder.encode(`${pending}\r\n`))

    const replies: Reply[] = []
    while (true) {
      let text = await this.readLine()
      const literals: Uint8Array[] = []
      let literal = text.match(/\{(\d+)\+?\}$/)
      while (literal) {
        literals.push(await this.readExact(Number(literal[1])))
        const rest = await this.readLine()
        text += rest
        literal = rest.match(/\{(\d+)\+?\}$/)
      }
      if (text.startsWith(`${tag} `)) {
        const status = text.slice(tag.length + 1)
        if (!/^OK\b/i.test(status)) throw new MailboxRefused(`邮箱回复：${status.slice(0, 160)}`)
        return replies
      }
      replies.push({ text, literals })
    }
  }
}

// ---------------------------------------------------------------------------
// 从每封信开头拆出工单字段
// ---------------------------------------------------------------------------

interface Head {
  uid: number
  messageId: string | null
  subject: string
  fromName: string | null
  fromEmail: string | null
  date: string | null
  summary: string | null
}

function firstMailbox(address: Address | undefined) {
  if (!address) return null
  if (address.group) return address.group[0] ?? null
  return address
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
}

function toSummary(email: Email) {
  const raw = email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : ''
  const text = raw.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return null
  return text.length <= SUMMARY_CHARS ? text : `${text.slice(0, SUMMARY_CHARS)}…`
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

/** IMAP INTERNALDATE，例如 22-Oct-2026 08:15:00 +1100，是信进这只邮箱的时间。 */
function parseInternalDate(text: string) {
  const raw = text.match(/INTERNALDATE "([^"]+)"/i)?.[1]
  if (!raw) return null
  const match = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/)
  if (!match) return null
  const month = MONTHS[match[2].toLowerCase()]
  if (month === undefined) return null
  const offset =
    (Number(match[8]) * 60 + Number(match[9])) * (match[7] === '-' ? -1 : 1)
  const utc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]) - offset,
    Number(match[6]),
  )
  return Number.isNaN(utc) ? null : new Date(utc).toISOString()
}

function headerOnly(bytes: Uint8Array) {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) {
      return bytes.subarray(0, index + 4)
    }
  }
  return bytes
}

async function parseHead(uid: number, bytes: Uint8Array, arrived?: string | null): Promise<Head> {
  let email: Email
  let summary: string | null = null
  try {
    email = await PostalMime.parse(bytes)
    summary = toSummary(email)
  } catch {
    // 开头 16 KB 拆不出正文时，至少把信头拆出来。
    email = await PostalMime.parse(headerOnly(bytes))
  }
  const sender = firstMailbox(email.from)
  const headerDate = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null
  const date = arrived || headerDate
  return {
    uid,
    messageId: email.messageId?.trim() || null,
    subject: email.subject?.trim() || '(无主题)',
    fromName: sender?.name?.trim() || null,
    fromEmail: sender?.address?.trim().toLowerCase() || null,
    date,
    summary,
  }
}

// ---------------------------------------------------------------------------
// 写库
// ---------------------------------------------------------------------------

interface Context {
  admin: SupabaseClient
  mailboxKey: string
  homeWarehouseId: string | null
  senderMap: Map<string, { customerId: string; warehouseId: string | null }>
  userId: string
}

interface StoredTicket {
  id: string
  title: string
  summary: string | null
  status: string
  imap_uid: number | null
  message_id: string | null
}

async function loadStored(ctx: Context, column: 'imap_uid' | 'message_id', values: Array<number | string>) {
  const found = new Map<string, StoredTicket>()
  for (let start = 0; start < values.length; start += 100) {
    const slice = values.slice(start, start + 100)
    if (!slice.length) continue
    let query = ctx.admin.from('tickets').select('id, title, summary, status, imap_uid, message_id').in(column, slice)
    if (column === 'imap_uid') query = query.eq('mailbox', ctx.mailboxKey)
    const { data, error } = await query
    if (error) throw error
    for (const row of data ?? []) {
      const stored = row as StoredTicket
      const key = column === 'imap_uid' ? String(stored.imap_uid) : String(stored.message_id)
      if (key && key !== 'null') found.set(key, stored)
    }
  }
  return found
}

/** 改标题和摘要。UID 或 Message-ID 换了也记到原工单上。状态、仓库、客户不动。标题变了才记一笔并清原信缓存。 */
async function updateStored(ctx: Context, ticket: StoredTicket, head: Head) {
  const titleChanged = head.subject !== ticket.title
  const summaryChanged = (head.summary ?? null) !== (ticket.summary ?? null)
  const uidChanged = ticket.imap_uid !== head.uid
  const messageChanged = Boolean(head.messageId) && head.messageId !== ticket.message_id
  if (!titleChanged && !summaryChanged && !uidChanged && !messageChanged) return false
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (titleChanged) patch.title = head.subject
  if (summaryChanged) patch.summary = head.summary
  if (uidChanged) patch.imap_uid = head.uid
  if (messageChanged) patch.message_id = head.messageId
  let { error } = await ctx.admin.from('tickets').update(patch).eq('id', ticket.id)
  if (error?.code === '23505') {
    delete patch.imap_uid
    delete patch.message_id
    const retry = await ctx.admin.from('tickets').update(patch).eq('id', ticket.id)
    error = retry.error
  }
  if (error) throw error
  ticket.title = head.subject
  ticket.summary = head.summary
  ticket.imap_uid = head.uid
  if (head.messageId) ticket.message_id = head.messageId
  if (!titleChanged) return false
  const { error: cacheError } = await ctx.admin.from('ticket_letters').delete().eq('ticket_id', ticket.id)
  if (cacheError) throw cacheError
  const { error: eventError } = await ctx.admin.from('ticket_events').insert({
    ticket_id: ticket.id,
    from_status: ticket.status,
    to_status: ticket.status,
    actor_id: ctx.userId,
    note: '邮件标题已更新',
  })
  if (eventError) throw eventError
  return true
}

function ticketRow(ctx: Context, head: Head) {
  const domain = head.fromEmail?.includes('@') ? `@${head.fromEmail.split('@')[1]}` : null
  const match =
    (head.fromEmail ? ctx.senderMap.get(head.fromEmail) : undefined) ??
    (domain ? ctx.senderMap.get(domain) : undefined) ??
    null
  return {
    row: {
      title: head.subject,
      summary: head.summary,
      status: 'new',
      source: 'email',
      batch: 'live',
      warehouse_id: match?.warehouseId ?? ctx.homeWarehouseId,
      customer_id: match?.customerId ?? null,
      is_new_sender: !match,
      mailbox: ctx.mailboxKey,
      message_id: head.messageId,
      imap_uid: head.uid,
      from_name: head.fromName,
      from_email: head.fromEmail,
      received_at: head.date,
    },
    isNewSender: !match,
  }
}

/** 整批建单；撞上唯一索引（别处刚建过）时改成逐张建，跳过重复的。 */
async function insertTickets(ctx: Context, rows: ReturnType<typeof ticketRow>['row'][]) {
  if (!rows.length) return [] as string[]
  const { data, error } = await ctx.admin.from('tickets').insert(rows).select('id')
  if (!error) return (data ?? []).map((row) => String(row.id))
  if (error.code !== '23505') throw error
  const ids: string[] = []
  for (const row of rows) {
    const single = await ctx.admin.from('tickets').insert(row).select('id').single()
    if (single.error) {
      if (single.error.code === '23505') continue
      throw single.error
    }
    ids.push(String(single.data.id))
  }
  return ids
}

async function saveBookmark(ctx: Context, lastUid: number, uidValidity: number) {
  const { error } = await ctx.admin.from('mail_sync_state').upsert({
    mailbox: ctx.mailboxKey,
    last_uid: lastUid,
    uid_validity: uidValidity,
    last_synced_at: new Date().toISOString(),
  })
  if (error) throw error
}

async function loadContext(admin: SupabaseClient, mailboxKey: string, userId: string): Promise<Context> {
  const [{ data: warehouses, error: warehouseError }, { data: senders, error: senderError }] = await Promise.all([
    admin.from('warehouses').select('id, is_home').eq('archived', false),
    admin.from('customer_senders').select('pattern, customers(id, warehouse_id, archived)'),
  ])
  if (warehouseError) throw warehouseError
  if (senderError) throw senderError
  const senderMap = new Map<string, { customerId: string; warehouseId: string | null }>()
  for (const row of senders ?? []) {
    const customer = (Array.isArray(row.customers) ? row.customers[0] : row.customers) as
      | { id: string; warehouse_id: string | null; archived: boolean }
      | null
    if (!customer || customer.archived) continue
    senderMap.set(String(row.pattern).trim().toLowerCase(), {
      customerId: customer.id,
      warehouseId: customer.warehouse_id,
    })
  }
  return {
    admin,
    mailboxKey,
    homeWarehouseId: warehouses?.find((row) => row.is_home)?.id ?? null,
    senderMap,
    userId,
  }
}

/** 「写入工单」在 30% 到 95% 之间按已处理的封数推进。取信头约占一批的七成时间。 */
const WRITE_FROM = 30
const WRITE_TO = 95
const FETCH_SHARE = 0.7

async function pull(ctx: Context, client: Imap, folder: string, report: Report): Promise<PullResult> {
  const uidValidity = await client.examine(folder)
  const listed = await client.arrivedSince(CATCHUP_SINCE)
  const storedByUid = await loadStored(ctx, 'imap_uid', listed.uids)
  const known = listed.uids.filter((uid) => storedByUid.has(String(uid)))
  const missing = listed.uids.filter((uid) => !storedByUid.has(String(uid)))
  const freshUids = missing.slice(0, MAX_PER_RUN)
  const pendingAfter = missing.length - freshUids.length
  report(
    WRITE_FROM,
    '找到新信',
    [
      missing.length
        ? pendingAfter
          ? `10月19日起还有 ${missing.length} 封没建单，这次处理 ${freshUids.length} 封`
          : `10月19日起 ${missing.length} 封还没建单`
        : listed.truncated
          ? '往前翻了 8000 封还没到 10月19日，先停在这里'
          : '10月19日起没有要新建的信',
      known.length ? `另外核对 ${known.length} 封已有工单的标题` : '',
    ]
      .filter(Boolean)
      .join('。'),
  )

  const total = freshUids.length + known.length
  let done = 0
  const at = (count: number) => (total ? WRITE_FROM + Math.floor(((WRITE_TO - WRITE_FROM) * count) / total) : WRITE_TO)
  const result: PullResult = {
    scanned: 0,
    inserted: 0,
    skipped: 0,
    newSenders: 0,
    updated: 0,
    mailbox: ctx.mailboxKey,
    lastUid: 0,
    mailboxMaxUid: listed.max,
    pending: pendingAfter,
  }
  const note = () => `新建 ${result.inserted} 单，标题更新 ${result.updated} 张`

  for (let start = 0; start < freshUids.length; start += BATCH) {
    const batch = freshUids.slice(start, start + BATCH)
    const raw = await client.heads(batch, HEAD_BYTES)
    result.scanned += batch.length
    done += batch.length
    report(at(done), '写入工单', `已取回 ${done} / ${total} 封。${note()}`)

    const heads: Head[] = []
    for (const uid of batch) {
      const part = raw.get(uid)
      if (!part) {
        result.skipped += 1
        continue
      }
      try {
        heads.push(await parseHead(uid, part.bytes, part.arrived))
      } catch {
        result.skipped += 1
      }
    }

    const byMessage = await loadStored(
      ctx,
      'message_id',
      heads.map((head) => head.messageId).filter((id): id is string => Boolean(id)),
    )
    const seenIds = new Set<string>()
    const fresh: ReturnType<typeof ticketRow>[] = []
    for (const head of heads) {
      const same = head.messageId ? byMessage.get(head.messageId) : undefined
      if (same) {
        if (await updateStored(ctx, same, head)) result.updated += 1
        else result.skipped += 1
        continue
      }
      if (head.messageId && seenIds.has(head.messageId)) {
        result.skipped += 1
        continue
      }
      if (head.messageId) seenIds.add(head.messageId)
      fresh.push(ticketRow(ctx, head))
    }

    const ids = await insertTickets(
      ctx,
      fresh.map((item) => item.row),
    )
    result.inserted += ids.length
    result.skipped += fresh.length - ids.length
    result.newSenders += fresh.filter((item) => item.isNewSender).length
    if (ids.length) {
      const { error } = await ctx.admin.from('ticket_events').insert(
        ids.map((ticketId) => ({
          ticket_id: ticketId,
          from_status: null,
          to_status: 'new',
          actor_id: ctx.userId,
          note: '从邮箱写入',
        })),
      )
      if (error) throw error
    }
    result.pending = pendingAfter + (freshUids.length - (start + batch.length))
    report(at(done), '写入工单', `已处理 ${done} / ${total} 封。${note()}`)
  }

  for (let start = 0; start < known.length; start += BATCH) {
    const batch = known.slice(start, start + BATCH)
    const raw = await client.headers(batch)
    const changed: number[] = []
    for (const uid of batch) {
      const bytes = raw.get(uid)
      const ticket = storedByUid.get(String(uid))
      if (!bytes || !ticket) {
        result.skipped += 1
        continue
      }
      try {
        const head = await parseHead(uid, bytes, null)
        if (head.subject === ticket.title) result.skipped += 1
        else changed.push(uid)
      } catch {
        result.skipped += 1
      }
    }
    if (changed.length) {
      const full = await client.heads(changed, HEAD_BYTES)
      result.scanned += changed.length
      for (const uid of changed) {
        const part = full.get(uid)
        const ticket = storedByUid.get(String(uid))
        if (!part || !ticket) {
          result.skipped += 1
          continue
        }
        try {
          const head = await parseHead(uid, part.bytes, part.arrived)
          if (await updateStored(ctx, ticket, head)) result.updated += 1
          else result.skipped += 1
        } catch {
          result.skipped += 1
        }
      }
    }
    done += batch.length
    report(at(done), '写入工单', `已核对 ${done} / ${total} 封。${note()}`)
  }

  await saveBookmark(ctx, listed.max, uidValidity)
  result.lastUid = listed.max
  return result
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: '只用 POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = platformKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS')
  const serviceKey = platformKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS')
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Supabase 环境不完整' }, 500)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: '未登录' }, 401)

  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
  } = await asUser.auth.getUser()
  if (!user) return json({ error: '未登录' }, 401)

  const host = Deno.env.get('IMAP_HOST')
  const imapUser = Deno.env.get('IMAP_USER')
  const imapPassword = Deno.env.get('IMAP_PASSWORD')
  const port = Number(Deno.env.get('IMAP_PORT') ?? '993')
  const folder = Deno.env.get('IMAP_FOLDER') ?? 'INBOX'
  if (!host || !imapUser || !imapPassword) {
    return json(
      {
        error:
          '还没有接邮箱。把 IMAP_HOST、IMAP_USER、IMAP_PASSWORD 写到 Edge Functions 的 Secrets（端口和文件夹可选，默认 993 和 INBOX）。',
      },
      503,
    )
  }

  const admin = createClient(supabaseUrl, serviceKey)
  return frameResponse(async (report) => {
    report(10, '已接到请求')
    let client: Imap | null = null
    try {
      const ctx = await loadContext(admin, `${imapUser}/${folder}`, user.id)
      client = await Imap.open(host, port)
      await client.login(imapUser, imapPassword)
      report(20, '连上邮箱', `${imapUser}/${folder}`)
      return await pull(ctx, client, folder, report)
    } finally {
      await client?.logout()
    }
  })
})
