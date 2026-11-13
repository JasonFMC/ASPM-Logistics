// 打开工单时读一封原信。函数只做这些事：
// 1. 核对 14 天缓存，有就直接给页面。
// 2. 没有缓存时，按工单记下的 UID 从邮箱取出整封原文。取出前先核对 Message-ID。
//    对不上或原位置已经空了，就在这只邮箱里按 Message-ID 找到新的 UID，记回工单，再取。
// 3. 页面拆好以后把正文送回来，这里写进 14 天缓存。附件不进缓存。
// 4. 「打开原邮件」另要一张两分钟的凭据。本机程序拿这张凭据把同一封原文存成文件，交给 Outlook 打开。
//    Outlook 不再按编号在自己的收件箱里查找。
// 邮箱以只读方式打开，不会把邮件标成已读。
//
// 读信的回复是一串帧，每行一个 JSON：进度、{"source": 总字节}、{"chunk": n}。
// {"chunk": n} 这一行后面紧跟 n 个字节的原文。原文边从邮箱收边转给页面，不在函数里攒整封；
// 传到一半出错时，错误仍是单独一行。交给 Outlook 的那一次没有帧，就是原文本身。
//
// 邮箱连接用 Deno 自带的 TLS 和下面的最小 IMAP 客户端，不用 imapflow：
// imapflow 在 Edge Runtime 的 Node 兼容 TLS 上收不完长回复，正文会一直卡住。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** 超过这个大小的信不在页面里拆。打开原邮件仍按同一位置把原文交给 Outlook。 */
const SOURCE_MAX = 25_000_000
/** 交给 Outlook 的原文上限。再大就留在邮箱里，这一次带不下来。 */
const OPEN_MAX = 200_000_000
const HANDOFF_MS = 2 * 60 * 1000
/** 页面送回来的正文超过这个大小就不缓存。 */
const CACHE_MAX = 900_000
const KEEP_DAYS = 14
const CACHE_VERSION = 2

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function messageOf(err: unknown) {
  return err instanceof Error && err.message ? err.message : '读取失败'
}

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

interface Frame {
  pct?: number
  step?: string
  size?: number
  source?: number
  chunk?: number
  letter?: unknown
  error?: string
}

type Send = { frame: (frame: Frame) => void; bytes: (bytes: Uint8Array) => void }

function frameResponse(run: (send: Send) => Promise<void>) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const push = (chunk: Uint8Array) => {
        if (!open) return
        try {
          controller.enqueue(chunk)
        } catch {
          open = false
        }
      }
      const send: Send = {
        frame: (frame) => push(encoder.encode(`${JSON.stringify(frame)}\n`)),
        bytes: push,
      }
      run(send)
        .catch((err: unknown) => send.frame({ error: messageOf(err) }))
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
    headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  })
}

function mailboxConfig() {
  const host = Deno.env.get('IMAP_HOST')
  const user = Deno.env.get('IMAP_USER')
  const pass = Deno.env.get('IMAP_PASSWORD')
  const port = Number(Deno.env.get('IMAP_PORT') ?? '993')
  const folder = Deno.env.get('IMAP_FOLDER') ?? 'INBOX'
  if (!host || !user || !pass) throw new Error('还没有接邮箱')
  return { host, user, pass, port, folder }
}

// ---------------------------------------------------------------------------
// 最小 IMAP 客户端：LOGIN、EXAMINE（只读打开）、UID FETCH、LOGOUT。
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 连上以后，邮箱多久一个字节都不发就算断了。 */
const IDLE_MS = 30_000
const CONNECT_MS = 15_000

type Part = string | { literal: Uint8Array }

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

  /** 只读打开一个文件夹，返回里面有多少封。读不到 EXISTS 时返回 -1。 */
  async examine(folder: string) {
    const lines = await this.run(['EXAMINE ', astring(folder)])
    for (const line of lines) {
      const match = line.match(/^\* (\d+) EXISTS/i)
      if (match) return Number(match[1])
    }
    return -1
  }

  async folderNames() {
    const lines = await this.run(['LIST ', astring(''), ' ', astring('*')])
    const names: string[] = []
    for (const line of lines) {
      if (!/^\* LIST /i.test(line) || /\\Noselect/i.test(line)) continue
      const match = line.match(/^\* LIST \([^)]*\) (?:"[^"]*"|NIL) (.+)$/i)
      if (!match) continue
      const raw = match[1].trim()
      const name = raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
        : raw
      if (name) names.push(name)
    }
    return names
  }

  /** 这封信的大小（字节）。位置是空的时返回 null。回复里只有 UID、没有大小时记成 0，表示信还在。 */
  async size(uid: number) {
    const lines = await this.run([`UID FETCH ${uid} (UID RFC822.SIZE)`])
    for (const line of lines) {
      const match = line.match(/RFC822\.SIZE (\d+)/i)
      if (match) return Number(match[1])
      if (new RegExp(`\\bUID ${uid}\\b`).test(line)) return 0
    }
    return null
  }

  /** 这个 UID 上的 Message-ID。位置是空的、或这封信没有这个信头时返回 null。折行会先拼回去。 */
  async messageIdOf(uid: number) {
    const parts: Uint8Array[] = []
    const lines = await this.run([`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])`], async (size) => {
      await this.readExact(size, (chunk) => parts.push(chunk))
    })
    let header = ''
    for (const part of parts) header += decoder.decode(part)
    for (const line of lines) header += `\n${line}`
    header = header.replace(/\r?\n[ \t]+/g, ' ')
    return header.match(/Message-ID:\s*(<[^>]+>|\S+)/i)?.[1]?.trim() ?? null
  }

  private searchUids(lines: string[]) {
    const found = new Set<number>()
    for (const line of lines) {
      const match = line.match(/^\* SEARCH\s+([0-9 ]+)/i)
      if (!match) continue
      for (const part of match[1].trim().split(/\s+/)) {
        const uid = Number(part)
        if (uid > 0) found.add(uid)
      }
    }
    return [...found].sort((a, b) => b - a)
  }

  /** 在当前文件夹里按 Message-ID 找 UID，新的在前。两种括号写法都试。 */
  async searchMessageId(messageId: string) {
    const bare = messageId.trim().replace(/^<|>$/g, '')
    if (!bare || /[\r\n"]/.test(bare)) return []
    for (const form of [`<${bare}>`, bare]) {
      const found = this.searchUids(await this.run(['UID SEARCH HEADER Message-ID ', astring(form)]))
      if (found.length) return found
    }
    return []
  }

  /** 当前文件夹里，落到这个日期窗口的信。编号搜索没有结果时用来核对。 */
  async searchDate(since: string, before: string) {
    return this.searchUids(await this.run([`UID SEARCH SINCE ${since} BEFORE ${before}`]))
  }

  /** 取整封原文。onStart 先拿到总字节数，onChunk 按块收内容。 */
  async source(uid: number, onStart: (size: number) => void, onChunk: (chunk: Uint8Array) => void) {
    let got = false
    await this.run([`UID FETCH ${uid} BODY.PEEK[]`], async (size) => {
      got = true
      onStart(size)
      await this.readExact(size, onChunk)
    })
    if (!got) throw new Error('刚对上的位置在取信时已经空了')
  }

  async logout() {
    try {
      await waitFor(this.run(['LOGOUT']), 3_000, '退出超时')
    } catch {
      // 退出失败不影响已经取到的信
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

  private async readExact(size: number, onChunk: (chunk: Uint8Array) => void) {
    let left = size
    if (this.buffer.length) {
      const take = Math.min(left, this.buffer.length)
      onChunk(this.buffer.slice(0, take))
      this.buffer = this.buffer.slice(take)
      left -= take
    }
    while (left > 0) {
      const chunk = await this.more()
      if (chunk.length <= left) {
        onChunk(chunk)
        left -= chunk.length
      } else {
        onChunk(chunk.slice(0, left))
        this.buffer = chunk.slice(left)
        left = 0
      }
    }
  }

  /** 发一条命令，读到这条命令的完成行为止。返回期间收到的其它行；遇到大段内容交给 onLiteral。 */
  private async run(parts: Part[], onLiteral?: (size: number) => Promise<void>) {
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

    const lines: string[] = []
    while (true) {
      let line = await this.readLine()
      let literal = line.match(/\{(\d+)\+?\}$/)
      while (literal) {
        const size = Number(literal[1])
        if (onLiteral) await onLiteral(size)
        else await this.readExact(size, () => undefined)
        const rest = await this.readLine()
        line += rest
        literal = rest.match(/\{(\d+)\+?\}$/)
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1)
        if (!/^OK\b/i.test(status)) throw new MailboxRefused(`邮箱回复：${status.slice(0, 160)}`)
        return lines
      }
      lines.push(line)
    }
  }
}

interface TicketMail {
  id: string
  mailbox: string | null
  message_id: string | null
  imap_uid: number | null
  imapFolder: string | null
  received_at: string | null
  /** 任务里的某一封。空着时按任务上的第一封信取。 */
  messageRowId: string | null
}

function normalizeMessageId(value: string | null | undefined) {
  return value?.trim().replace(/^<|>$/g, '').toLowerCase() ?? ''
}

function sameMessageId(a: string | null | undefined, b: string | null | undefined) {
  const left = normalizeMessageId(a)
  const right = normalizeMessageId(b)
  return left.length > 0 && left === right
}

async function loadTicket(admin: SupabaseClient, ticketId: string, messageId?: string) {
  if (messageId) {
    const full = await admin
      .from('ticket_messages')
      .select('id, ticket_id, mailbox, message_id, imap_uid, imap_folder, received_at')
      .eq('id', messageId)
      .maybeSingle()
    const fallback =
      full.error && /imap_folder|schema cache/i.test(full.error.message)
        ? await admin
            .from('ticket_messages')
            .select('id, ticket_id, mailbox, message_id, imap_uid, received_at')
            .eq('id', messageId)
            .maybeSingle()
        : null
    const error = fallback ? fallback.error : full.error
    const data = fallback ? fallback.data : full.data
    if (error) throw new Error(error.message)
    if (!data || data.ticket_id !== ticketId) throw new Error('找不到这封信')
    const folder = 'imap_folder' in data ? (data.imap_folder as string | null) : null
    return {
      id: ticketId,
      mailbox: (data.mailbox as string | null) ?? null,
      message_id: (data.message_id as string | null) ?? null,
      imap_uid: (data.imap_uid as number | null) ?? null,
      imapFolder: folder,
      received_at: (data.received_at as string | null) ?? null,
      messageRowId: String(data.id),
    } satisfies TicketMail
  }
  const { data, error } = await admin
    .from('tickets')
    .select('id, mailbox, message_id, imap_uid, received_at')
    .eq('id', ticketId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('找不到这张工单')
  return { ...(data as Omit<TicketMail, 'messageRowId' | 'imapFolder'>), imapFolder: null, messageRowId: null }
}

/** UID 被邮箱重新分配后，清掉占着这个位置的另一张单，再把当前位置记到这张单上。 */
async function rememberUid(admin: SupabaseClient, ticket: TicketMail, uid: number) {
  if (ticket.imap_uid === uid) return
  if (ticket.messageRowId) {
    const write = () => admin.from('ticket_messages').update({ imap_uid: uid }).eq('id', ticket.messageRowId)
    const first = await write()
    if (!first.error) {
      ticket.imap_uid = uid
      return
    }
    if (first.error.code !== '23505') throw new Error(first.error.message)
    let clear = admin.from('ticket_messages').update({ imap_uid: null }).eq('imap_uid', uid).neq('id', ticket.messageRowId)
    clear = ticket.mailbox ? clear.eq('mailbox', ticket.mailbox) : clear.is('mailbox', null)
    const cleared = await clear
    if (cleared.error) throw new Error(cleared.error.message)
    const second = await write()
    if (second.error) throw new Error(second.error.message)
    ticket.imap_uid = uid
    return
  }
  const write = () => admin.from('tickets').update({ imap_uid: uid }).eq('id', ticket.id)
  const first = await write()
  if (!first.error) {
    ticket.imap_uid = uid
    return
  }
  if (first.error.code !== '23505') throw new Error(first.error.message)
  let clear = admin.from('tickets').update({ imap_uid: null }).eq('imap_uid', uid).neq('id', ticket.id)
  clear = ticket.mailbox ? clear.eq('mailbox', ticket.mailbox) : clear.is('mailbox', null)
  const cleared = await clear
  if (cleared.error) throw new Error(cleared.error.message)
  const second = await write()
  if (second.error) throw new Error(second.error.message)
  ticket.imap_uid = uid
}

async function rememberPlace(admin: SupabaseClient, ticket: TicketMail, folder: string, uid: number) {
  await rememberUid(admin, ticket, uid)
  if (!ticket.messageRowId || !folder || folder === ticket.imapFolder) return
  const { error } = await admin.from('ticket_messages').update({ imap_folder: folder }).eq('id', ticket.messageRowId)
  if (!error) ticket.imapFolder = folder
}

function folderLeaf(name: string) {
  return name.split('/').pop() ?? name
}

/** 存放来信的文件夹。已发送、草稿、垃圾和已删除不拿来对这封被挪走的来信。 */
function keepsFiledMail(name: string) {
  const leaf = folderLeaf(name)
  if (/sent items|sent mail|sent messages|^sent$/i.test(leaf) || /已发送|寄件备份/.test(leaf)) return false
  if (/^drafts?$/i.test(leaf) || /草稿/.test(leaf)) return false
  if (/trash|deleted items|deleted messages/i.test(leaf) || /已删除|废件/.test(leaf)) return false
  if (/junk|spam/i.test(leaf) || /垃圾邮件|垃圾箱/.test(leaf)) return false
  return true
}

/** 归档文件夹先看。所有邮件留到最后。 */
function foldersAfterMove(names: string[], recorded: string) {
  const first: string[] = []
  const middle: string[] = []
  const last: string[] = []
  for (const name of names) {
    if (name.toLowerCase() === recorded.toLowerCase() || !keepsFiledMail(name)) continue
    const leaf = folderLeaf(name)
    if (/^archive$/i.test(leaf) || /归档/.test(leaf)) first.push(name)
    else if (/all mail$/i.test(leaf) || name.includes('所有邮件')) last.push(name)
    else middle.push(name)
  }
  return [...first, ...middle, ...last]
}

/** 这张工单上后来记下的位置。收信当时的收件箱空了，先看这些位置。 */
async function laterSpots(admin: SupabaseClient, ticket: TicketMail) {
  const { data, error } = await admin
    .from('ticket_messages')
    .select('imap_uid, imap_folder')
    .eq('ticket_id', ticket.id)
    .like('message_id', 'seen:%')
    .not('imap_uid', 'is', null)
  if (error || !data) return []
  const recorded = (ticket.imapFolder ?? '').toLowerCase()
  const spots: Array<{ folder: string; uid: number }> = []
  for (const row of data) {
    const folder = typeof row.imap_folder === 'string' ? row.imap_folder : ''
    const uid = Number(row.imap_uid)
    if (!folder || !uid || spots.length >= 40) continue
    if (folder.toLowerCase() === recorded && uid === ticket.imap_uid) continue
    spots.push({ folder, uid })
  }
  return spots
}

async function letterAt(client: Imap, folder: string, uid: number, messageId: string) {
  try {
    await client.examine(folder)
  } catch {
    return false
  }
  try {
    const header = await client.messageIdOf(uid)
    return Boolean(header && sameMessageId(header, messageId))
  } catch {
    return false
  }
}

/** 上次记下的位置先打开。信还在就用。收件箱里的信会被挪走，位置空了就到它现在的文件夹，对上后把新位置写回去。 */
async function resolveUid(client: Imap, admin: SupabaseClient, ticket: TicketMail) {
  const recorded = ticket.imapFolder || mailboxConfig().folder
  const here = await lookInFolder(client, ticket, recorded, true, true)
  if (here) {
    await rememberPlace(admin, ticket, recorded, here)
    return here
  }
  if (!ticket.message_id || ticket.message_id.startsWith('seen:')) throw new Error('这封信已经离开上次记下的位置')

  for (const spot of await laterSpots(admin, ticket)) {
    if (!(await letterAt(client, spot.folder, spot.uid, ticket.message_id))) continue
    await rememberPlace(admin, ticket, spot.folder, spot.uid)
    return spot.uid
  }

  let names: string[] = []
  try {
    names = await client.folderNames()
  } catch {
    names = []
  }
  const budget = { left: 80 }
  for (const name of foldersAfterMove(names, recorded)) {
    if (budget.left <= 0) break
    const uid = await lookInFolder(client, ticket, name, true, false, budget)
    if (!uid) continue
    await rememberPlace(admin, ticket, name, uid)
    return uid
  }
  throw new Error('这封信已经离开上次记下的位置，其他文件夹里没有对上')
}

/** 打开一个文件夹。上次的 UID 还是这封信就直接返回。位置空了，或已经换成另一封，就在这个文件夹里再对。 */
async function lookInFolder(
  client: Imap,
  ticket: TicketMail,
  folder: string,
  allowDate: boolean,
  useRecordedUid: boolean,
  budget?: { left: number },
) {
  try {
    await client.examine(folder)
  } catch {
    return null
  }
  if (useRecordedUid && ticket.imap_uid) {
    const size = await client.size(ticket.imap_uid)
    if (size !== null) {
      if (!ticket.message_id || ticket.message_id.startsWith('seen:')) return ticket.imap_uid
      try {
        const header = await client.messageIdOf(ticket.imap_uid)
        if (!header || sameMessageId(header, ticket.message_id)) return ticket.imap_uid
      } catch {
        return ticket.imap_uid
      }
    }
  }
  if (!ticket.message_id || ticket.message_id.startsWith('seen:')) return null
  return findInSelected(client, ticket.message_id, allowDate ? ticket.received_at : null, budget)
}

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function imapDay(iso: string, shiftDays: number) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + shiftDays)
  return `${date.getUTCDate()}-${IMAP_MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

async function findInSelected(client: Imap, messageId: string, receivedAt?: string | null, budget?: { left: number }) {
  const consider = async (uid: number) => {
    if (budget) {
      if (budget.left <= 0) return 'stop' as const
      budget.left -= 1
    }
    const header = await client.messageIdOf(uid)
    return header && sameMessageId(header, messageId) ? ('hit' as const) : ('skip' as const)
  }
  try {
    for (const uid of await client.searchMessageId(messageId)) {
      try {
        const verdict = await consider(uid)
        if (verdict === 'stop') return null
        if (verdict === 'hit') return uid
      } catch {
        return null
      }
    }
  } catch {
    // 这只邮箱经常不按编号搜索。下面改用收信日期把当天的信对一遍。
  }
  const since = receivedAt ? imapDay(receivedAt, -1) : ''
  const before = receivedAt ? imapDay(receivedAt, 2) : ''
  if (!since || !before) return null
  let uids: number[] = []
  try {
    uids = await client.searchDate(since, before)
  } catch {
    return null
  }
  for (const uid of uids.slice(0, 40)) {
    try {
      const verdict = await consider(uid)
      if (verdict === 'stop') return null
      if (verdict === 'hit') return uid
    } catch {
      return null
    }
  }
  return null
}

async function openMailbox() {
  const { host, user, pass, port, folder } = mailboxConfig()
  const client = await Imap.open(host, port)
  try {
    await client.login(user, pass)
    await client.examine(folder)
    return client
  } catch (err) {
    await client.logout()
    throw err
  }
}

async function loadCache(admin: SupabaseClient, ticketId: string) {
  const now = new Date().toISOString()
  await admin.from('ticket_letters').delete().lt('expires_at', now)
  const { data, error } = await admin
    .from('ticket_letters')
    .select('payload')
    .eq('ticket_id', ticketId)
    .gt('expires_at', now)
    .maybeSingle()
  if (error || !data?.payload) return null
  const payload = data.payload as { v?: number }
  return payload.v === CACHE_VERSION ? payload : null
}

async function readLetter(admin: SupabaseClient, ticketId: string, messageId: string | undefined, fresh: boolean, send: Send) {
  send.frame({ pct: 10, step: '已接到请求' })
  if (!messageId && !fresh) {
    const cached = await loadCache(admin, ticketId)
    if (cached) {
      send.frame({ pct: 100, step: '查到缓存', letter: cached })
      return
    }
  }
  const ticket = await loadTicket(admin, ticketId, messageId)
  if (!ticket.imap_uid && !ticket.message_id) {
    send.frame({ pct: 100, step: '读完正文', letter: null })
    return
  }
  send.frame({ pct: 20, step: '已核对缓存' })

  const client = await openMailbox()
  try {
    send.frame({ pct: 30, step: '连上邮箱' })
    const uid = await resolveUid(client, admin, ticket)
    const size = await client.size(uid)
    if (size === null) throw new Error('刚对上的位置在取信时已经空了')
    if (size > SOURCE_MAX) {
      throw new Error(`这封信有 ${Math.round(size / 1_000_000)} MB，页面不拆这么大的信。点「打开原邮件」，Outlook 会打开从邮箱取出的这一封。`)
    }
    send.frame({ pct: 40, step: '取到信', size })
    await client.source(
      uid,
      (total) => send.frame({ pct: 45, step: '取回正文', source: total }),
      (chunk) => {
        send.frame({ chunk: chunk.length })
        send.bytes(chunk)
      },
    )
  } finally {
    await client.logout()
  }
}

async function saveCache(admin: SupabaseClient, ticketId: string, letter: unknown) {
  if (!letter || typeof letter !== 'object' || typeof (letter as { html?: unknown }).html !== 'string') {
    return json({ error: '正文格式不对' }, 400)
  }
  const payload = { ...(letter as Record<string, unknown>), v: CACHE_VERSION }
  if (JSON.stringify(payload).length > CACHE_MAX) return json({ saved: false })
  const ticket = await loadTicket(admin, ticketId)
  const received = ticket.received_at ? new Date(ticket.received_at) : new Date()
  const expires = new Date(received.getTime() + KEEP_DAYS * 24 * 60 * 60 * 1000)
  if (expires.getTime() <= Date.now()) return json({ saved: false })
  const { error } = await admin
    .from('ticket_letters')
    .upsert({ ticket_id: ticketId, payload, expires_at: expires.toISOString() })
  if (error) return json({ error: error.message }, 500)
  const files = (letter as { attachments?: unknown }).attachments
  const marked = await admin
    .from('tickets')
    .update({ has_attachment: Array.isArray(files) && files.length > 0 })
    .eq('id', ticketId)
  if (marked.error && !/has_attachment/i.test(marked.error.message)) return json({ error: marked.error.message }, 500)
  return json({ saved: true })
}

function b64url(bytes: Uint8Array) {
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlDecode(text: string) {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4))
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const bytes = new Uint8Array(bin.length)
  for (let index = 0; index < bin.length; index += 1) bytes[index] = bin.charCodeAt(index)
  return bytes
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index]
  return diff === 0
}

async function hmac(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)))
}

async function signHandoff(ticketId: string, messageId: string | null, secret: string) {
  const payload = b64url(encoder.encode(JSON.stringify({ tid: ticketId, mid: messageId, exp: Date.now() + HANDOFF_MS })))
  return `${payload}.${b64url(await hmac(secret, payload))}`
}

async function verifyHandoff(token: string, secret: string) {
  const match = token.match(/^([A-Za-z0-9_-]{10,500})\.([A-Za-z0-9_-]{10,200})$/)
  if (!match) throw new Error('打开凭据无效')
  let actual: Uint8Array
  try {
    actual = b64urlDecode(match[2])
  } catch {
    throw new Error('打开凭据无效')
  }
  if (!sameBytes(await hmac(secret, match[1]), actual)) throw new Error('打开凭据无效')
  let parsed: { tid?: string; mid?: string; exp?: number }
  try {
    parsed = JSON.parse(decoder.decode(b64urlDecode(match[1]))) as { tid?: string; mid?: string; exp?: number }
  } catch {
    throw new Error('打开凭据无效')
  }
  if (!parsed.tid || !/^[0-9a-f-]{36}$/i.test(parsed.tid)) throw new Error('打开凭据无效')
  if (parsed.mid && !/^[0-9a-f-]{36}$/i.test(parsed.mid)) throw new Error('打开凭据无效')
  if (!parsed.exp || parsed.exp < Date.now()) throw new Error('打开凭据已过期，请再点一次')
  return { ticketId: parsed.tid, messageId: parsed.mid ?? null }
}

function rawResponse(size: number, run: (push: (chunk: Uint8Array) => void) => Promise<void>) {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await run((chunk) => controller.enqueue(chunk))
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
  return new Response(stream, {
    headers: {
      ...cors,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="original.eml"',
    },
  })
}

/** 按核对过的 UID 把原文流出去。调用方拿文件打开，不再查找。 */
async function streamOriginal(admin: SupabaseClient, ticketId: string, messageId: string | null) {
  const ticket = await loadTicket(admin, ticketId, messageId ?? undefined)
  if (!ticket.imap_uid && !ticket.message_id) throw new Error('这张工单没有原信')
  const client = await openMailbox()
  try {
    const uid = await resolveUid(client, admin, ticket)
    const size = await client.size(uid)
    if (size === null) throw new Error('刚对上的位置在取信时已经空了')
    if (size > OPEN_MAX) {
      throw new Error(`这封信有 ${Math.round(size / 1_000_000)} MB，这一次带不下来。原文仍在邮箱里。`)
    }
    return rawResponse(size, async (push) => {
      try {
        await client.source(uid, () => undefined, push)
      } finally {
        await client.logout()
      }
    })
  } catch (err) {
    await client.logout()
    throw err
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: '只用 POST' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = platformKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS')
  const serviceKey = platformKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS')
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Supabase 环境不完整' }, 500)

  let body: { ticketId?: string; messageId?: string; fresh?: boolean; cache?: unknown; intent?: string; handoffToken?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: '缺少工单' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceKey)
  if (body.handoffToken) {
    try {
      const opened = await verifyHandoff(body.handoffToken, serviceKey)
      return await streamOriginal(admin, opened.ticketId, opened.messageId)
    } catch (err) {
      return json({ error: messageOf(err) }, 400)
    }
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: '未登录' }, 401)
  const asUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })
  const {
    data: { user },
  } = await asUser.auth.getUser()
  if (!user) return json({ error: '未登录' }, 401)

  const ticketId = body.ticketId?.trim() ?? ''
  if (!ticketId) return json({ error: '缺少工单' }, 400)

  const messageId = body.messageId?.trim() || undefined
  if (body.intent === 'outlook') {
    try {
      return json({ token: await signHandoff(ticketId, messageId ?? null, serviceKey) })
    } catch (err) {
      return json({ error: messageOf(err) }, 500)
    }
  }
  if (body.cache !== undefined) {
    try {
      return await saveCache(admin, ticketId, body.cache)
    } catch (err) {
      return json({ error: messageOf(err) }, 500)
    }
  }
  return frameResponse((send) => readLetter(admin, ticketId, messageId, body.fresh === true, send))
})
