// 从任务邮箱拉新信建工单。只把工单字段写进库，原信留在邮箱里，附件和正文全文不入库。
// 邮箱以只读方式打开，不会把邮件标成已读。
//
// 流程：每次请求重新登录任务邮箱（不保持连接）→
// 按到达时间找出 2026-10-19（本周一，澳洲东部）0 点之后收到的信。
// 收件箱和其他存放来信的文件夹一起看，所以信被提前挪出收件箱也不会漏。
// 已发送、草稿、垃圾邮件和已删除不在这里读。每 50 封一批，按时间从早到晚：
// 没建过单的，先看是不是已有任务的后续：回复头对得上，或去掉回复/转发后标题相同且来往地址里有这个客户，
// 就并进还没完成的任务。我们发出去的信在「已发送」里，属于这段来往的会补进同一张任务。对不上的才新建。已完成的任务不再并入。
// 同一封信改了标题，仍改原任务的标题和第一条内容，不另建。
// UID 没变的，只读信头；标题变了再取开头 16 KB，改标题和摘要，清掉原信缓存。状态、仓库、客户和流程不动。
// 开头 16 KB 拆不出正文时，按信件结构另取正文那一段，不把附件一起取回来。引用的文字随正文记下。
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
/** 一次最多处理这么多封新信。再多，免费的拉信服务会做到一半被掐断。没做完的下一次继续。 */
const MAX_PER_RUN = 40
/** 任务档案按收到时间保留两年，给免费数据库留下空余。 */
const ARCHIVE_KEEP_MS = 730 * 24 * 60 * 60 * 1000
const BATCH = 50
/** 每封信先取开头这么多字节。整封比这短时，正文已经在里面。 */
const HEAD_BYTES = 16_384
/** 正文那一段单独再取时的上限。附件不在这一段里。 */
const TEXT_PEEK = 65_536
const SUMMARY_CHARS = 400
/** 聊天里一条消息留下的新内容。 */
const BODY_CHARS = 4_000
/** 引用别人的文字一起留下，超过的截掉。 */
const QUOTE_CHARS = 8_000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

function messageOf(err: unknown) {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message)
  return '更新失败'
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
  archived: number
  threaded?: number
  oldest?: string | null
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
    const present: number[] = []
    let scannedMin = max
    if (!max || Number.isNaN(since)) return { max, uids: kept, present, scannedMin: 0, truncated: false }
    const window = 200
    const maxWindows = 40
    let truncated = false
    for (let step = 0; step < maxWindows; step += 1) {
      const end = max - step * window
      if (end < 1) break
      const start = Math.max(1, end - window + 1)
      if (start < scannedMin) scannedMin = start
      const replies = await this.run([`UID FETCH ${start}:${end} (UID INTERNALDATE)`])
      const rows: Array<{ uid: number; arrived: number | null }> = []
      for (const reply of replies) {
        if (!/^\* \d+ FETCH/i.test(reply.text)) continue
        const uid = Number(reply.text.match(/\bUID (\d+)/i)?.[1] ?? 0)
        if (!uid) continue
        const arrived = parseInternalDate(reply.text)
        rows.push({ uid, arrived: arrived ? Date.parse(arrived) : null })
        present.push(uid)
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
    return { max, uids: kept, present, scannedMin, truncated }
  }

  /** 当前文件夹里，到达日期不早于 since 的 UID。 */
  async searchSince(sinceIso: string) {
    const match = sinceIso.match(/^(\d{4})-(\d{2})-(\d{2})/)
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const day = match ? `${Number(match[3])}-${months[Number(match[2]) - 1]}-${match[1]}` : '1-Jan-2026'
    const replies = await this.run([`UID SEARCH SINCE ${day}`])
    const uids: number[] = []
    for (const reply of replies) {
      const found = reply.text.match(/^\* SEARCH\s+([0-9 ]+)/i)
      if (!found?.[1]?.trim()) continue
      for (const part of found[1].trim().split(/\s+/)) {
        const uid = Number(part)
        if (uid) uids.push(uid)
      }
    }
    return uids
  }

  /** 只取这批信的到达时间，不取正文。 */
  async internalDates(uids: number[]) {
    const found = new Map<number, string | null>()
    for (let start = 0; start < uids.length; start += 50) {
      const slice = uids.slice(start, start + 50)
      if (!slice.length) continue
      const replies = await this.run([`UID FETCH ${slice.join(',')} (UID INTERNALDATE)`])
      for (const reply of replies) {
        if (!/^\* \d+ FETCH/i.test(reply.text)) continue
        const uid = Number(reply.text.match(/\bUID (\d+)/i)?.[1] ?? 0)
        if (!uid) continue
        found.set(uid, parseInternalDate(reply.text))
      }
    }
    return found
  }

  async folderNames() {
    const replies = await this.run(['LIST ', astring(''), ' ', astring('*')])
    const names: string[] = []
    for (const reply of replies) {
      const line = reply.text
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

  /** 当前文件夹里有没有这封信。只搜索，不取正文。 */
  async hasMessageId(messageId: string) {
    const found = await this.searchMessageId(messageId)
    return found.length > 0
  }

  /** 按 Message-ID 找当前文件夹里的 UID。 */
  async searchMessageId(messageId: string) {
    const bare = messageId.trim().replace(/^<|>$/g, '')
    const uids: number[] = []
    if (!bare || /[\r\n"]/.test(bare)) return uids
    for (const form of [`<${bare}>`, bare]) {
      const replies = await this.run(['UID SEARCH HEADER Message-ID ', astring(form)])
      for (const reply of replies) {
        const match = reply.text.match(/^\* SEARCH\s+([0-9 ]+)/i)
        if (!match?.[1]?.trim()) continue
        for (const part of match[1].trim().split(/\s+/)) {
          const uid = Number(part)
          if (uid) uids.push(uid)
        }
      }
      if (uids.length) break
    }
    return uids
  }

  /** 只看结构，取出附件名字和正文在第几段，不取文件本身。 */
  async describe(uids: number[]) {
    const found = new Map<number, MessageLayout>()
    if (!uids.length) return found
    const replies = await this.run([`UID FETCH ${uids.join(',')} (UID BODYSTRUCTURE)`])
    for (const reply of replies) {
      if (!/^\* \d+ FETCH/i.test(reply.text)) continue
      const uid = reply.text.match(/\bUID (\d+)/i)
      if (!uid) continue
      found.set(Number(uid[1]), {
        files: filesFromStructure(reply.text),
        text: textSectionFrom(reply.text),
      })
    }
    return found
  }

  /** 只取正文的这一段，不取附件。 */
  async peekSection(uid: number, section: string, bytes: number) {
    if (!/^\d+(?:\.\d+)*$/.test(section)) return null
    const replies = await this.run([`UID FETCH ${uid} (BODY.PEEK[${section}]<0.${bytes}>)`])
    for (const reply of replies) {
      if (reply.literals[0]?.length) return reply.literals[0]
    }
    return null
  }

  /** 只看结构，用来记有没有附件，不取正文。 */
  async structures(uids: number[]) {
    if (!uids.length) return new Map<number, boolean>()
    const replies = await this.run([`UID FETCH ${uids.join(',')} (UID BODYSTRUCTURE)`])
    const found = new Map<number, boolean>()
    for (const reply of replies) {
      if (!/^\* \d+ FETCH/i.test(reply.text)) continue
      const uid = reply.text.match(/\bUID (\d+)/i)
      if (!uid) continue
      found.set(Number(uid[1]), /"ATTACHMENT"/i.test(reply.text) || /\("FILENAME"\s+"/i.test(reply.text))
    }
    return found
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

interface MessageFile {
  index: number
  name: string
  size: number
  type: string
}

interface TextSection {
  section: string
  subtype: 'plain' | 'html'
  charset: string
  size: number
}

interface MessageLayout {
  files: MessageFile[]
  text: TextSection | null
}

interface Head {
  uid: number
  folder: string
  messageId: string | null
  inReplyTo: string | null
  references: string | null
  subject: string
  fromName: string | null
  fromEmail: string | null
  toEmails: string[]
  date: string | null
  summary: string | null
  body: string | null
  /** 开头那一段里已经拆出的正文字数。 */
  textLength: number
  /** 开头那一段没有把整封信取完。 */
  truncated: boolean
}

function firstMailbox(address: Address | undefined) {
  if (!address) return null
  if (address.group) return address.group[0] ?? null
  return address
}

function addressList(value: Address | Address[] | undefined) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  const emails: string[] = []
  for (const item of list) {
    const email = clean(firstMailbox(item)?.address)?.toLowerCase()
    if (email && !emails.includes(email)) emails.push(email)
  }
  return emails
}

function htmlToText(html: string) {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /src\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
      const cid = /cid:([^"'\s>]+)/i.exec(src)?.[1] ?? src
      const name = cid.split(/[/\\]/).pop()?.split('?')[0]?.split('@')[0]?.trim() || 'image'
      return `\n[image:${name}]\n`
    })
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

/** 数据库的 JSON 不接受空字符，也不接受落单的 Unicode 代理项。信里偶尔会带上，原样写入就会报 unsupported Unicode escape sequence。 */
function plainText(value: string | null | undefined) {
  if (!value) return ''
  let out = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0) continue
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1]
        index += 1
      }
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue
    out += value[index]
  }
  return out
}

function clean(value: string | null | undefined) {
  const text = plainText(value).trim()
  return text || null
}

function decodeQuotedPrintable(value: string) {
  if (!value) return ''
  const marks = value.match(/=[0-9A-Fa-f]{2}/g)
  if (!/=\r?\n/.test(value) && (marks?.length ?? 0) < 3) return value
  const unfolded = value.replace(/=\r?\n/g, '')
  const decodeBytes = (bytes: number[]) => new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
  const tidy = (text: string) => text.replace(/[\u200b\u200c\u200d\ufeff]/g, '').replace(/\u00a0/g, ' ')
  if (/[^\u0000-\u007f]/.test(unfolded)) {
    return tidy(unfolded.replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) => decodeBytes((run.match(/[0-9A-Fa-f]{2}/g) ?? []).map((hex) => Number.parseInt(hex, 16)))))
  }
  const bytes: number[] = []
  for (let index = 0; index < unfolded.length; index += 1) {
    if (unfolded[index] === '=' && /[0-9A-Fa-f]{2}/.test(unfolded.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(unfolded.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }
    bytes.push(unfolded.charCodeAt(index))
  }
  return tidy(decodeBytes(bytes))
}

function letterText(email: Email) {
  const fromHtml = email.html ? htmlToText(email.html) : ''
  const fromText = email.text?.trim() ? email.text : ''
  const plainHasImage = /\[image:|\[cid:|<image\d+\.(?:png|jpe?g|gif)>|image\d+\.(?:png|jpe?g|gif)@/i.test(fromText)
  const raw = /\[image:/i.test(fromHtml) && !plainHasImage ? fromHtml : fromText || fromHtml
  return plainText(decodeQuotedPrintable(raw)).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function summaryFrom(text: string) {
  const { fresh, quotes } = splitLetter(text)
  const source = fresh || quotes[0]?.body || ''
  if (!source) return null
  return source.length <= SUMMARY_CHARS ? source : `${source.slice(0, SUMMARY_CHARS)}…`
}

interface QuotePiece {
  heading: string
  body: string
}

function isQuoteStart(lines: string[], index: number) {
  const line = lines[index]?.trim() ?? ''
  if (!line) return false
  if (/^>+/.test(line)) return true
  if (/^-{2,}\s*(?:原始邮件|Original Message)\s*-{2,}$/i.test(line)) return true
  if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line)) return true
  if (/^On .+ wrote:\s*$/i.test(line) || /^在.+写道[:：]?\s*$/.test(line)) return true
  if (onWroteSpan(lines, index) !== null) return true
  if (/^发件人[:：]\s*\S/.test(line)) return true
  if (/^_{5,}$/.test(line)) {
    return lines.slice(index + 1, index + 4).some((item) => /^(?:From|发件人)\s*[:：]\s*\S/i.test(item.trim()))
  }
  if (/^From:\s+\S/i.test(line)) {
    const window = lines.slice(index, index + 8).join('\n')
    return /^(?:Sent|Date|To|Cc|Subject|发送时间|日期|收件人|抄送|主题)\s*[:：]/im.test(window)
  }
  return false
}

function onWroteSpan(lines: string[], index: number) {
  let joined = ''
  for (let cursor = index; cursor < Math.min(lines.length, index + 3); cursor += 1) {
    joined = `${joined} ${lines[cursor].trim()}`.trim()
    if (/^On\s+.{10,}wrote:\s*$/i.test(joined) && /@|\d/.test(joined)) return cursor + 1
  }
  return null
}

function quoteIsAngled(line: string) {
  return /^>+/.test(line) || /^On .+ wrote:\s*$/i.test(line) || /^在.+写道[:：]?\s*$/.test(line)
}

function quoteEnd(lines: string[], index: number) {
  const wrote = onWroteSpan(lines, index)
  if (wrote !== null) {
    const after = lines[wrote]?.trim() ?? ''
    if (/^>+/.test(after)) {
      let cursor = wrote
      while (cursor < lines.length && (!lines[cursor].trim() || /^>+/.test(lines[cursor].trim()))) cursor += 1
      return cursor
    }
    return lines.length
  }
  if (quoteIsAngled(lines[index].trim())) {
    let cursor = index + 1
    while (cursor < lines.length) {
      const text = lines[cursor].trim()
      if (!text || quoteIsAngled(text)) {
        cursor += 1
        continue
      }
      break
    }
    return cursor
  }
  return lines.length
}

function quoteHeading(lines: string[], index: number, end: number) {
  const wrote = onWroteSpan(lines, index)
  if (wrote !== null) {
    const window = lines.slice(index, wrote).join(' ')
    const named = window.match(/<([^>]+)>/)?.[1] || window.replace(/^On\s+/i, '').replace(/\s+wrote:\s*$/i, '').trim()
    return named.replace(/\s+/g, ' ').trim().slice(0, 160)
  }
  const window = lines.slice(index, Math.min(end, index + 8))
  for (const raw of window) {
    const line = raw.trim().replace(/^>+\s?/, '')
    const from = line.match(/^(?:From|发件人)\s*[:：]\s*(.+)$/i)
    if (from) return from[1].trim().slice(0, 160)
  }
  const first = lines[index].trim().replace(/^>+\s?/, '')
  if (/^On .+ wrote:\s*$/i.test(first)) {
    const tail = first.replace(/^On\s+/i, '').replace(/\s+wrote:\s*$/i, '').trim()
    const named = tail.match(/([^<@\n]+<[^>]+>|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\s*$/)
    return (named?.[1] ?? tail).trim().slice(0, 160)
  }
  return ''
}

function stripQuoteHeaders(block: string[]) {
  const header = /^(?:>+\s*)?(?:From|Sent|Date|To|Cc|Subject|发件人|发送时间|日期|收件人|抄送|主题)\s*[:：]/i
  let start = 0
  while (start < block.length) {
    const raw = block[start].trim()
    const text = raw.replace(/^>+\s?/, '')
    if (!text) {
      start += 1
      continue
    }
    if (
      header.test(raw) ||
      /^-{2,}/.test(text) ||
      /^_{5,}$/.test(text) ||
      (/^On\s+/i.test(text) && text.length < 160 && !/[.!?]\s/.test(text) && !/[.!?]$/.test(text)) ||
      /^wrote:\s*$/i.test(text) ||
      /^在.+写道[:：]?\s*$/.test(text) ||
      /^Forwarded message$/i.test(text)
    ) {
      start += 1
      continue
    }
    break
  }
  return block
    .slice(start)
    .map((line) => line.replace(/^>+\s?/, '').replace(/^>\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 新写的话留在前面。引用整段留下，后面打开工单时再决定收起还是显示。 */
function splitLetter(text: string) {
  const lines = text.split('\n')
  const fresh: string[] = []
  const quotes: QuotePiece[] = []
  let index = 0
  while (index < lines.length) {
    if (!isQuoteStart(lines, index)) {
      fresh.push(lines[index])
      index += 1
      continue
    }
    const end = quoteEnd(lines, index)
    const body = stripQuoteHeaders(lines.slice(index, end))
    if (body) quotes.push({ heading: quoteHeading(lines, index, end), body })
    index = Math.max(end, index + 1)
  }
  return { fresh: fresh.join('\n').replace(/\n{3,}/g, '\n\n').trim(), quotes }
}

function packLetter(text: string) {
  const { fresh, quotes } = splitLetter(text)
  const keptFresh = fresh.length <= BODY_CHARS ? fresh : `${fresh.slice(0, BODY_CHARS)}…`
  let packed = keptFresh
  let used = 0
  for (const quote of quotes) {
    const heading = quote.heading.replace(/[\r\n\u0000-\u001f]/g, ' ').trim()
    const body = quote.body.trim()
    if (!body) continue
    const room = QUOTE_CHARS - used
    if (room <= 40) break
    const block = body.length <= room ? body : `${body.slice(0, room)}…`
    packed += `\u001e\n${heading}\n${block}`
    used += block.length
  }
  return packed.trim() || null
}

function usableLetter(text: string) {
  const sample = text.slice(0, 500)
  if (!sample.trim()) return false
  if (sample.startsWith('%PDF') || sample.startsWith('PK')) return false
  const compact = sample.replace(/\s+/g, '')
  if (compact.length > 180 && /^[A-Za-z0-9+/=]+$/.test(compact)) return false
  let controls = 0
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index)
    if (code < 9 || (code > 13 && code < 32)) controls += 1
  }
  return controls < 6
}

function sectionText(bytes: Uint8Array, section: TextSection) {
  const name = section.charset.trim().toLowerCase().replace(/^utf8$/, 'utf-8') || 'utf-8'
  let decoded = ''
  try {
    decoded = new TextDecoder(name).decode(bytes)
  } catch {
    decoded = new TextDecoder('utf-8').decode(bytes)
  }
  const source = decodeQuotedPrintable(decoded)
  const text = plainText(section.subtype === 'html' ? htmlToText(source) : source)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return usableLetter(text) ? text : ''
}

async function readLetter(client: Imap, uid: number, section: TextSection) {
  try {
    const bytes = await client.peekSection(uid, section.section, TEXT_PEEK)
    if (!bytes?.length) return ''
    return sectionText(bytes, section)
  } catch {
    return ''
  }
}

/** 开头没把正文取全时，另取正文那一段。 */
async function ensureText(client: Imap, head: Head, section: TextSection | null) {
  if (!head.uid) return
  const apply = (text: string) => {
    if (!text || text.length <= head.textLength) return false
    head.body = packLetter(text)
    head.summary = clean(summaryFrom(text))
    head.textLength = text.length
    return true
  }
  if (section) {
    if (!head.truncated && head.textLength > 0) return
    const text = await readLetter(client, head.uid, section)
    if (!text) return
    head.body = packLetter(text)
    head.summary = clean(summaryFrom(text))
    head.textLength = text.length
    return
  }
  if (head.textLength > 0) return
  const guesses: TextSection[] = [
    { section: '1', subtype: 'plain', charset: 'utf-8', size: 0 },
    { section: '1.1', subtype: 'plain', charset: 'utf-8', size: 0 },
    { section: '1.2', subtype: 'html', charset: 'utf-8', size: 0 },
  ]
  for (const guess of guesses) {
    if (apply(await readLetter(client, head.uid, guess))) return
  }
}

function bareSubject(subject: string) {
  let text = subject.trim()
  const prefix = /^(?:(?:re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i
  let next = text.replace(prefix, '').trim()
  while (next !== text) {
    text = next
    next = text.replace(prefix, '').trim()
  }
  return text.toLowerCase()
}

function decodeMimeWord(value: string) {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_all, charset: string, encoding: string, data: string) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        const bin = atob(data)
        const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0))
        return new TextDecoder(charset || 'utf-8').decode(bytes)
      }
      const text = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_pair, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      return new TextDecoder(charset || 'utf-8').decode(Uint8Array.from(text, (char) => char.charCodeAt(0)))
    } catch {
      return value
    }
  })
}

function filesFromStructure(raw: string) {
  const files: MessageFile[] = []
  const pattern = /\("FILENAME"\s+"((?:\\.|[^"\\])*)"\)/gi
  let match = pattern.exec(raw)
  while (match) {
    const name = decodeMimeWord(match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')).trim()
    const before = raw.slice(Math.max(0, match.index - 500), match.index)
    const mime = [...before.matchAll(/\("([A-Za-z0-9-]+)"\s+"([A-Za-z0-9.+-]+)"/g)].at(-1)
    const size = before.match(/"(?:BASE64|QUOTED-PRINTABLE|7BIT|8BIT|BINARY)"\s+(\d+)/i)
    const type = mime ? `${mime[1].toLowerCase()}/${mime[2].toLowerCase()}` : 'application/octet-stream'
    if (!type.startsWith('multipart/') && name) {
      files.push({
        index: files.length,
        name,
        size: size ? Number(size[1]) : 0,
        type,
      })
    }
    match = pattern.exec(raw)
  }
  return files
}

interface StructureTok {
  k: 'lp' | 'rp' | 'nil' | 'str' | 'num'
  v?: string | number
}

function tokenizeStructure(input: string) {
  const tokens: StructureTok[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]
    if (char === '(') {
      tokens.push({ k: 'lp' })
      index += 1
      continue
    }
    if (char === ')') {
      tokens.push({ k: 'rp' })
      index += 1
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      index += 1
      continue
    }
    if (input.startsWith('NIL', index) && (index + 3 === input.length || /[\s)]/.test(input[index + 3] ?? ''))) {
      tokens.push({ k: 'nil' })
      index += 3
      continue
    }
    if (char === '"') {
      let value = ''
      index += 1
      while (index < input.length) {
        if (input[index] === '\\') {
          value += input[index + 1] ?? ''
          index += 2
          continue
        }
        if (input[index] === '"') {
          index += 1
          break
        }
        value += input[index]
        index += 1
      }
      tokens.push({ k: 'str', v: value })
      continue
    }
    let end = index
    while (end < input.length && !/[\s()]/.test(input[end] ?? '')) end += 1
    const atom = input.slice(index, end)
    if (/^\d+$/.test(atom)) tokens.push({ k: 'num', v: Number(atom) })
    else tokens.push({ k: 'str', v: atom })
    index = end
  }
  return tokens
}

function skipStructure(tokens: StructureTok[], index: number) {
  const token = tokens[index]
  if (!token) return index
  if (token.k !== 'lp') return index + 1
  let depth = 0
  do {
    if (tokens[index]?.k === 'lp') depth += 1
    else if (tokens[index]?.k === 'rp') depth -= 1
    index += 1
  } while (depth > 0 && index < tokens.length)
  return index
}

function structureString(tokens: StructureTok[], index: number): [string, number] {
  const token = tokens[index]
  if (!token || token.k === 'nil') return ['', index + (token ? 1 : 0)]
  if (token.k === 'str' || token.k === 'num') return [String(token.v ?? ''), index + 1]
  return ['', index]
}

function paramValue(tokens: StructureTok[], key: string) {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (token?.k === 'str' && next?.k === 'str' && String(token.v).toLowerCase() === key) return String(next.v)
  }
  return ''
}

interface StructurePart {
  section: string
  type: string
  subtype: string
  charset: string
  size: number
  disposition: string
}

function walkStructure(tokens: StructureTok[], index: number, section: string): [StructurePart[], number] {
  if (tokens[index]?.k !== 'lp') return [[], index]
  index += 1
  if (tokens[index]?.k === 'lp') {
    const parts: StructurePart[] = []
    let number = 1
    while (tokens[index]?.k === 'lp') {
      const child = section ? `${section}.${number}` : String(number)
      const [children, next] = walkStructure(tokens, index, child)
      parts.push(...children)
      index = next
      number += 1
    }
    let depth = 1
    while (index < tokens.length && depth > 0) {
      if (tokens[index]?.k === 'lp') depth += 1
      else if (tokens[index]?.k === 'rp') depth -= 1
      index += 1
    }
    return [parts, index]
  }
  const [type, afterType] = structureString(tokens, index)
  const [subtype, afterSubtype] = structureString(tokens, afterType)
  let cursor = afterSubtype
  let charset = ''
  if (tokens[cursor]?.k === 'lp') {
    const start = cursor
    cursor = skipStructure(tokens, cursor)
    charset = paramValue(tokens.slice(start + 1, cursor - 1), 'charset')
  } else if (tokens[cursor]) cursor += 1
  cursor = skipStructure(tokens, cursor)
  cursor = skipStructure(tokens, cursor)
  cursor = skipStructure(tokens, cursor)
  let size = 0
  if (tokens[cursor]?.k === 'num') {
    size = Number(tokens[cursor]?.v ?? 0)
    cursor += 1
  }
  let disposition = ''
  let depth = 1
  while (cursor < tokens.length && depth > 0) {
    if (tokens[cursor]?.k === 'lp') {
      depth += 1
      const label = tokens[cursor + 1]
      if (depth === 2 && label?.k === 'str' && /^(ATTACHMENT|INLINE)$/i.test(String(label.v))) {
        disposition = String(label.v).toLowerCase()
      }
    } else if (tokens[cursor]?.k === 'rp') depth -= 1
    cursor += 1
  }
  return [[
    {
      section: section || '1',
      type: type.toLowerCase(),
      subtype: subtype.toLowerCase(),
      charset: charset || 'utf-8',
      size,
      disposition,
    },
  ], cursor]
}

function bodyStructureSlice(raw: string) {
  const match = /BODYSTRUCTURE\s+/i.exec(raw)
  if (!match || match.index === undefined) return ''
  const start = raw.indexOf('(', match.index)
  if (start < 0) return ''
  let depth = 0
  for (let index = start; index < raw.length; index += 1) {
    if (raw[index] === '"') {
      index += 1
      while (index < raw.length && raw[index] !== '"') {
        if (raw[index] === '\\') index += 1
        index += 1
      }
      continue
    }
    if (raw[index] === '(') depth += 1
    else if (raw[index] === ')') {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  return raw.slice(start)
}

function textSectionFrom(raw: string): TextSection | null {
  const slice = bodyStructureSlice(raw)
  if (!slice) return null
  try {
    const [parts] = walkStructure(tokenizeStructure(slice), 0, '')
    const texts = parts.filter((part) => part.type === 'text' && (part.subtype === 'plain' || part.subtype === 'html') && part.disposition !== 'attachment')
    const pick = texts.find((part) => part.subtype === 'plain') ?? texts.find((part) => part.subtype === 'html')
    if (!pick) return null
    return {
      section: pick.section,
      subtype: pick.subtype === 'html' ? 'html' : 'plain',
      charset: pick.charset,
      size: pick.size,
    }
  } catch {
    return null
  }
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
  let email: Email | null = null
  try {
    email = await PostalMime.parse(bytes)
  } catch {
    // 开头这一段拆不出正文时，至少把信头拆出来。
    try {
      email = await PostalMime.parse(headerOnly(bytes))
    } catch {
      email = null
    }
  }
  const text = email ? letterText(email) : ''
  const sender = email ? firstMailbox(email.from) : null
  const headerDate = email?.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null
  const date = arrived || headerDate
  const replied = (email ?? {}) as Email & { inReplyTo?: string; references?: string; to?: Address | Address[]; cc?: Address | Address[] }
  const toEmails = [...addressList(replied.to), ...addressList(replied.cc)]
  return {
    uid,
    folder: '',
    messageId: clean(email?.messageId),
    inReplyTo: clean(replied.inReplyTo),
    references: clean(replied.references),
    subject: clean(email?.subject) || '(无主题)',
    fromName: clean(sender?.name),
    fromEmail: clean(sender?.address)?.toLowerCase() ?? null,
    toEmails: toEmails.filter((item, index) => toEmails.indexOf(item) === index),
    date,
    summary: clean(summaryFrom(text)),
    body: text ? packLetter(text) : null,
    textLength: text.length,
    truncated: bytes.length >= HEAD_BYTES,
  }
}

// ---------------------------------------------------------------------------
// 写库
// ---------------------------------------------------------------------------

interface Context {
  admin: SupabaseClient
  mailboxKey: string
  ourEmail: string | null
  homeWarehouseId: string | null
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

function bareMessageId(value: string) {
  return value.trim().replace(/^<|>$/g, '').toLowerCase()
}

function idKeys(value: string) {
  const bare = value.trim().replace(/^<|>$/g, '')
  const lower = bare.toLowerCase()
  return [...new Set([value.trim(), bare, lower, `<${bare}>`, `<${lower}>`])].filter(Boolean)
}

function referencedIds(head: Head) {
  const chunks = [head.inReplyTo, head.references].filter(Boolean).join(' ')
  const found = chunks.match(/<[^>\s]+>|[^<>\s,;]+@[^<>\s,;]+/g) ?? []
  const ids: string[] = []
  for (const item of found) {
    const bare = bareMessageId(item)
    if (bare && !ids.includes(bare)) ids.push(bare)
  }
  return ids.slice(0, 20)
}

async function messageUids(ctx: Context, uids: number[]) {
  const found = new Set<string>()
  for (let start = 0; start < uids.length; start += 100) {
    const slice = uids.slice(start, start + 100)
    if (!slice.length) continue
    const { data, error } = await ctx.admin
      .from('ticket_messages')
      .select('imap_uid')
      .eq('mailbox', ctx.mailboxKey)
      .in('imap_uid', slice)
    if (error) return found
    for (const row of data ?? []) found.add(String(row.imap_uid))
  }
  return found
}

async function parentFromRefs(ctx: Context, refs: string[]) {
  const keys = refs.flatMap((id) => idKeys(id)).slice(0, 80)
  if (!keys.length) return null
  const [messages, tickets] = await Promise.all([
    ctx.admin.from('ticket_messages').select('ticket_id, message_id, tickets(status)').in('message_id', keys),
    ctx.admin.from('tickets').select('id, message_id, status').in('message_id', keys),
  ])
  if (messages.error || tickets.error) return null
  const byId = new Map<string, { ticketId: string; status: string }>()
  for (const row of tickets.data ?? []) {
    const id = typeof row.message_id === 'string' ? bareMessageId(row.message_id) : ''
    if (!id) continue
    byId.set(id, { ticketId: String(row.id), status: String(row.status ?? '') })
  }
  for (const row of messages.data ?? []) {
    const id = typeof row.message_id === 'string' ? bareMessageId(row.message_id) : ''
    if (!id) continue
    const joined = row.tickets as { status?: string } | { status?: string }[] | null
    const status = Array.isArray(joined) ? joined[0]?.status : joined?.status
    byId.set(id, { ticketId: String(row.ticket_id), status: String(status ?? '') })
  }
  for (const ref of refs) {
    const hit = byId.get(ref)
    if (!hit) continue
    if (hit.status === 'done' || hit.status === 'cancelled') return 'closed' as const
    return hit.ticketId
  }
  return null
}

async function parentFromSubject(ctx: Context, head: Head) {
  const wanted = bareSubject(head.subject)
  const parties = matchParties(ctx, head)
  if (!wanted || wanted === '(无主题)' || !parties.length) return null
  const { data, error } = await ctx.admin
    .from('tickets')
    .select('id, title, from_email, status, received_at')
    .in('from_email', parties)
    .not('status', 'in', '(done,cancelled)')
    .order('received_at', { ascending: false })
    .limit(100)
  if (error) return null
  const hit = (data ?? []).find((row) => bareSubject(String(row.title ?? '')) === wanted)
  return hit ? String(hit.id) : null
}

/** 回复头优先。对上已完成的任务就另开一张，不再按标题并到别的任务上。 */
async function findParent(ctx: Context, head: Head) {
  const refs = referencedIds(head)
  if (refs.length) {
    const hit = await parentFromRefs(ctx, refs)
    if (hit === 'closed') return null
    if (hit) return hit
  }
  return parentFromSubject(ctx, head)
}

function headParties(head: Head) {
  const emails = [head.fromEmail, ...head.toEmails].filter((email): email is string => Boolean(email))
  return emails.filter((email, index) => emails.indexOf(email) === index)
}

function matchParties(ctx: Context, head: Head) {
  return headParties(head).filter((email) => email !== ctx.ourEmail)
}

function sentFolderName(names: string[]) {
  const leaf = (name: string) => name.split('/').pop() ?? name
  const tests = [/sent items/i, /sent mail/i, /^sent$/i, /sent messages/i, /已发送/, /寄件备份/]
  for (const test of tests) {
    const hit = names.find((name) => test.test(leaf(name)))
    if (hit) return hit
  }
  return null
}

async function messageExists(ctx: Context, messageId: string) {
  const keys = idKeys(messageId)
  const [messages, tickets] = await Promise.all([
    ctx.admin.from('ticket_messages').select('id').in('message_id', keys).limit(1),
    ctx.admin.from('tickets').select('id').in('message_id', keys).limit(1),
  ])
  if (messages.error && tickets.error) return false
  return Boolean(messages.data?.length || tickets.data?.length)
}

async function rememberParties(ctx: Context, ticketId: string, emails: string[]) {
  const { data, error } = await ctx.admin.from('tickets').select('parties').eq('id', ticketId).maybeSingle()
  if (error) return
  const have = new Set(
    String(data?.parties ?? '')
      .split(/\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  )
  for (const email of emails) have.add(email)
  await ctx.admin.from('tickets').update({ parties: [...have].join('\n') }).eq('id', ticketId)
}

async function customerAddresses(ctx: Context) {
  const { data, error } = await ctx.admin.from('ticket_folders').select('senders').eq('kind', 'customer')
  if (error) return [] as string[]
  const rules: string[] = []
  for (const row of data ?? []) {
    for (const line of String(row.senders ?? '').split(/\n/)) {
      const needle = line.trim().toLowerCase().replace(/^@/, '')
      if (needle && !rules.includes(needle)) rules.push(needle)
    }
  }
  return rules
}

function addressListed(email: string, rules: string[]) {
  const lower = email.trim().toLowerCase()
  const domain = lower.includes('@') ? lower.slice(lower.lastIndexOf('@') + 1) : ''
  return rules.some((rule) => (rule.includes('@') ? lower === rule : domain === rule))
}

/** 我们发出的信，对方地址出现在客户名称里，就归到这个客户。 */
function outsideParty(ctx: Context, head: Head, rules: string[]) {
  const ours = ctx.ourEmail
  const candidates = head.fromEmail && head.fromEmail !== ours ? [head.fromEmail] : head.toEmails.filter((email) => email !== ours)
  return candidates.find((email) => addressListed(email, rules)) ?? null
}

async function insertMessage(ctx: Context, ticketId: string, head: Head, files: MessageFile[]) {
  const row: Record<string, unknown> = {
    ticket_id: ticketId,
    mailbox: head.folder && head.folder.toLowerCase() !== 'inbox' ? `${ctx.ourEmail}/${head.folder}` : ctx.mailboxKey,
    message_id: head.messageId,
    imap_uid: head.uid,
    imap_folder: head.folder || null,
    from_name: head.fromName,
    from_email: head.fromEmail,
    to_emails: head.toEmails.join('\n'),
    subject: head.subject,
    received_at: head.date,
    body: head.body,
    attachments: files,
  }
  let { error } = await ctx.admin.from('ticket_messages').insert(row)
  if (error && /imap_folder|to_emails|schema cache/i.test(error.message)) {
    delete row.imap_folder
    delete row.to_emails
    const retry = await ctx.admin.from('ticket_messages').insert(row)
    error = retry.error
  }
  if (!error) {
    await rememberParties(ctx, ticketId, headParties(head))
    await touchLatest(ctx, ticketId, head.date)
    return 'ok' as const
  }
  if (error.code === '23505') return 'dup' as const
  throw error
}

async function touchLatest(ctx: Context, ticketId: string, at: string | null) {
  if (!at) return
  const next = Date.parse(at)
  if (Number.isNaN(next)) return
  const { data } = await ctx.admin.from('tickets').select('received_at').eq('id', ticketId).maybeSingle()
  const current = typeof data?.received_at === 'string' ? Date.parse(data.received_at) : NaN
  if (Number.isFinite(current) && current >= next) return
  await ctx.admin.from('tickets').update({ received_at: at, updated_at: new Date().toISOString() }).eq('id', ticketId)
}

/** 同一封信挪到了新文件夹。把原信那一行的位置改过去，打开时不再回到已经空掉的收件箱。 */
async function relocateLetter(ctx: Context, head: Head, mailbox: string) {
  if (!head.uid || !head.messageId || head.messageId.startsWith('seen:')) return
  const found = await ctx.admin
    .from('ticket_messages')
    .select('id, imap_uid, imap_folder, mailbox')
    .in('message_id', idKeys(head.messageId))
    .limit(1)
  const row = found.data?.[0]
  if (!row?.id) return
  const folder = head.folder || null
  if (
    Number(row.imap_uid) === head.uid &&
    String(row.imap_folder ?? '') === String(folder ?? '') &&
    String(row.mailbox ?? '') === mailbox
  ) {
    return
  }
  await ctx.admin.from('ticket_messages').update({ imap_uid: null }).eq('mailbox', mailbox).eq('imap_uid', head.uid).neq('id', row.id)
  const next = { imap_uid: head.uid, imap_folder: folder, mailbox }
  const write = await ctx.admin.from('ticket_messages').update(next).eq('id', row.id)
  if (write.error && /imap_folder|schema cache/i.test(write.error.message)) {
    await ctx.admin.from('ticket_messages').update({ imap_uid: head.uid, mailbox }).eq('id', row.id)
  }
}

/** 这封信已经处理过。位置如果变了，写回原信那一行，再记下这个文件夹里的 UID，下一轮选信时直接排除。 */
async function rememberSpot(ctx: Context, head: Head, knownTicketId?: string) {
  if (!head.uid) return
  const mailbox = messageMailbox(ctx, head.folder && head.folder.toLowerCase() !== 'inbox' ? head.folder : 'inbox')
  await relocateLetter(ctx, head, mailbox)
  let ticketId = knownTicketId ?? ''
  if (!ticketId && head.messageId) {
    const keys = idKeys(head.messageId)
    const message = await ctx.admin.from('ticket_messages').select('ticket_id').in('message_id', keys).limit(1)
    const fromMessage = message.data?.[0]?.ticket_id
    if (fromMessage) ticketId = String(fromMessage)
    if (!ticketId) {
      const ticket = await ctx.admin.from('tickets').select('id').in('message_id', keys).limit(1)
      const fromTicket = ticket.data?.[0]?.id
      if (fromTicket) ticketId = String(fromTicket)
    }
  }
  if (!ticketId) return
  const row: Record<string, unknown> = {
    ticket_id: ticketId,
    mailbox,
    message_id: `seen:${mailbox}:${head.uid}`,
    imap_uid: head.uid,
    imap_folder: head.folder || null,
    received_at: head.date,
  }
  let { error } = await ctx.admin.from('ticket_messages').insert(row)
  if (error && /imap_folder|schema cache/i.test(error.message)) {
    delete row.imap_folder
    error = (await ctx.admin.from('ticket_messages').insert(row)).error
  }
}

async function bumpMailCount(ctx: Context, ticketId: string) {
  const { data, error } = await ctx.admin.from('tickets').select('mail_count').eq('id', ticketId).maybeSingle()
  if (error || !data) return
  const next = Number(data.mail_count ?? 0) + 1
  await ctx.admin
    .from('tickets')
    .update({ mail_count: next, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
}

async function messagesReady(ctx: Context) {
  const { error } = await ctx.admin.from('ticket_messages').select('id').limit(1)
  return !error
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
  return {
    row: {
      title: head.subject,
      summary: head.summary,
      status: 'new',
      source: 'email',
      batch: 'live',
      warehouse_id: ctx.homeWarehouseId,
      mailbox: ctx.mailboxKey,
      message_id: head.messageId,
      imap_uid: head.uid as number | null,
      from_name: head.fromName,
      from_email: head.fromEmail,
      parties: headParties(head).join('\n'),
      received_at: head.date,
    },
    isNewSender: false,
  }
}

/** 整批建单；撞上唯一索引（别处刚建过）时改成逐张建，跳过重复的。 */
async function insertTickets(
  ctx: Context,
  rows: Array<ReturnType<typeof ticketRow>['row'] & { id?: string; mail_count?: number; filed_folder?: string | null }>,
) {
  if (!rows.length) return [] as string[]
  const first = await ctx.admin.from('tickets').insert(rows).select('id')
  let data = first.data
  let error = first.error
  if (error && /parties|filed_folder|schema cache/i.test(error.message)) {
    const stripped = rows.map((row) => {
      const copy = { ...row }
      delete copy.parties
      delete copy.filed_folder
      return copy
    })
    const retry = await ctx.admin.from('tickets').insert(stripped).select('id')
    data = retry.data
    error = retry.error
  }
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

/** 下一轮从这封信的前一天找。没有刻度时仍从 10 月 19 日找。 */
function searchSinceIso(through: number | null) {
  const floor = Date.parse(CATCHUP_SINCE)
  if (through === null || Number.isNaN(through)) return CATCHUP_SINCE
  const used = Math.max(through - 24 * 60 * 60 * 1000, floor)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(used))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const iso = `${pick('year')}-${pick('month')}-${pick('day')}T00:00:00+11:00`
  return Number.isNaN(Date.parse(iso)) ? CATCHUP_SINCE : iso
}

function sydneyWhen(time: number) {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Sydney',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(time))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}月${pick('day')}日 ${pick('hour')}:${pick('minute')}`
}

async function loadReceivedThrough(ctx: Context, mailbox: string) {
  const { data, error } = await ctx.admin.from('mail_sync_state').select('received_through').eq('mailbox', mailbox).maybeSingle()
  if (error || !data) return null
  const raw = data.received_through
  if (typeof raw !== 'string') return null
  const time = Date.parse(raw)
  return Number.isNaN(time) ? null : time
}

async function saveReceivedThrough(ctx: Context, mailbox: string, iso: string) {
  const { error } = await ctx.admin.from('mail_sync_state').upsert({ mailbox, received_through: iso })
  if (error && /received_through|schema cache/i.test(error.message)) return
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
  const { data: warehouses, error: warehouseError } = await admin.from('warehouses').select('id, is_home').eq('archived', false)
  if (warehouseError) throw warehouseError
  return {
    admin,
    mailboxKey,
    ourEmail: mailboxKey.split('/')[0]?.toLowerCase() || null,
    homeWarehouseId: warehouses?.find((row) => row.is_home)?.id ?? null,
    userId,
  }
}

function folderLeaf(name: string) {
  return name.split('/').pop() ?? name
}

/** 归档文件夹先看。所有邮件留到最后，避免还没搜到就当成删掉了。 */
function foldersToConfirm(names: string[], home: string) {
  const first: string[] = []
  const middle: string[] = []
  const last: string[] = []
  for (const name of names) {
    if (name.toLowerCase() === home.toLowerCase()) continue
    const leaf = folderLeaf(name)
    if (/^archive$/i.test(leaf) || /归档/.test(leaf)) first.push(name)
    else if (/all mail$/i.test(leaf) || name.includes('所有邮件')) last.push(name)
    else middle.push(name)
  }
  return [...first, ...middle, ...last]
}

function bareIds(values: Array<string | null | undefined>) {
  const ids: string[] = []
  for (const value of values) {
    if (!value) continue
    const bare = value.trim().replace(/^<|>$/g, '')
    if (bare && !ids.includes(bare)) ids.push(bare)
  }
  return ids
}

async function threadMessages(ctx: Context, ids: string[]) {
  const grouped = new Map<string, Array<{ messageId: string | null; uid: number | null }>>()
  for (let start = 0; start < ids.length; start += 100) {
    const slice = ids.slice(start, start + 100)
    if (!slice.length) continue
    const { data, error } = await ctx.admin.from('ticket_messages').select('ticket_id, message_id, imap_uid').in('ticket_id', slice)
    if (error) return null
    for (const row of data ?? []) {
      const ticketId = String(row.ticket_id)
      const list = grouped.get(ticketId) ?? []
      list.push({
        messageId: typeof row.message_id === 'string' ? row.message_id : null,
        uid: Number(row.imap_uid) || null,
      })
      grouped.set(ticketId, list)
    }
  }
  return grouped
}

/** 找到就返回文件夹。没搜完是 unknown，调用方必须留着任务。整只邮箱都没有才是 missing。 */
async function locateMail(client: Imap, home: string, messageIds: string[], knownNames?: string[]) {
  const unknown = { status: 'unknown' as const }
  const missing = { status: 'missing' as const }
  if (!messageIds.length) return unknown
  try {
    await client.examine(home)
  } catch {
    return unknown
  }
  for (const id of messageIds) {
    if (await client.hasMessageId(id)) return { folder: home }
  }
  let names = knownNames
  if (!names) {
    try {
      names = await client.folderNames()
    } catch {
      return unknown
    }
  }
  let checked = 0
  for (const name of foldersToConfirm(names, home)) {
    if (checked >= 80) return unknown
    checked += 1
    try {
      await client.examine(name)
    } catch {
      return unknown
    }
    for (const id of messageIds) {
      if (await client.hasMessageId(id)) return { folder: name }
    }
  }
  return missing
}

async function rememberFiling(ctx: Context, ticketId: string, folder: string) {
  const update = await ctx.admin.from('tickets').update({ imap_uid: null, filed_folder: folder }).eq('id', ticketId)
  if (!update.error) return
  if (/filed_folder|schema cache/i.test(update.error.message)) return
}

async function shelveTicket(
  ctx: Context,
  row: Record<string, unknown>,
  events: Map<string, string>,
  customers: Map<string, string>,
  warehouses: Map<string, string>,
  assignees: Map<string, string>,
) {
  const ticketId = String(row.id)
  const messageId = typeof row.message_id === 'string' ? row.message_id : null
  const saved = await ctx.admin.from('ticket_archive').upsert(
    {
      ticket_id: ticketId,
      received_at: row.received_at ?? null,
      title: clip(String(row.title ?? '（无标题）'), 300) || '（无标题）',
      summary: clip(typeof row.summary === 'string' ? row.summary : null, 500),
      status: typeof row.status === 'string' ? row.status : null,
      from_name: clip(typeof row.from_name === 'string' ? row.from_name : null, 120),
      from_email: clip(typeof row.from_email === 'string' ? row.from_email : null, 200),
      customer_name: customers.get(String(row.id ?? '')) ?? null,
      warehouse_name: warehouses.get(String(row.warehouse_id ?? '')) ?? null,
      assignee_name: assignees.get(String(row.claimed_by ?? '')) ?? null,
      waiting_reason: typeof row.waiting_reason === 'string' ? row.waiting_reason : null,
      priority: typeof row.priority === 'string' ? row.priority : null,
      due_at: row.due_at ?? null,
      closed_at: row.closed_at ?? null,
      message_id: messageId,
      facts: clipFacts(row.facts),
      log: events.get(ticketId) ?? '',
    },
    { onConflict: 'ticket_id' },
  )
  if (saved.error) {
    if (/ticket_archive|schema cache/i.test(saved.error.message)) {
      throw new Error('留档表还没有。请在 SQL Editor 运行 supabase/ticket_ops.sql 后再更新邮件。')
    }
    throw saved.error
  }
  const removed = await ctx.admin.from('tickets').delete().eq('id', ticketId)
  if (removed.error) throw removed.error
}

/** 收到满两年的档案清掉。信不在了才留档，原文和附件不进档案。从收件箱挪走的不算丢失。 */
async function retireMissing(
  ctx: Context,
  client: Imap,
  home: string,
  listed: { max: number; present: number[]; scannedMin: number },
  report: Report,
) {
  const cutoff = new Date(Date.now() - ARCHIVE_KEEP_MS).toISOString()
  await ctx.admin.from('tickets').delete().eq('status', 'done').lt('closed_at', cutoff)
  await ctx.admin.from('tickets').delete().eq('status', 'done').is('closed_at', null).lt('updated_at', cutoff)
  const purged = await ctx.admin.from('ticket_archive').delete().lt('received_at', cutoff)
  if (purged.error && !/ticket_archive|schema cache/i.test(purged.error.message)) throw purged.error
  if (!purged.error) {
    const unnamed = await ctx.admin.from('ticket_archive').delete().is('received_at', null).lt('archived_at', cutoff)
    if (unnamed.error && !/ticket_archive|schema cache/i.test(unnamed.error.message)) throw unnamed.error
  }
  if (!listed.max || listed.scannedMin < 1) return await confirmFiled(ctx, client, home, report)

  const present = new Set(listed.present)
  const columns = [
    'id, title, summary, status, message_id, imap_uid, from_name, from_email, received_at, warehouse_id, claimed_by, waiting_reason, priority, due_at, closed_at, facts',
    'id, title, summary, status, message_id, imap_uid, from_name, from_email, received_at, warehouse_id, claimed_by',
    'id, title, summary, status, message_id, imap_uid, from_name, from_email, received_at, warehouse_id',
  ]
  let rows: Record<string, unknown>[] | null = null
  let lastError: { message: string } | null = null
  for (const column of columns) {
    const loaded = await ctx.admin
      .from('tickets')
      .select(column)
      .eq('mailbox', ctx.mailboxKey)
      .eq('source', 'email')
      .gte('imap_uid', listed.scannedMin)
      .lte('imap_uid', listed.max)
    if (!loaded.error) {
      rows = (loaded.data ?? []) as Record<string, unknown>[]
      break
    }
    lastError = loaded.error
  }
  if (!rows) throw new Error(lastError?.message ?? '读不到要核对的工单')

  const gone = rows.filter((row) => {
    const uid = Number(row.imap_uid)
    return uid > 0 && !present.has(uid)
  })
  const filedAway = await confirmFiled(ctx, client, home, report)
  if (!gone.length) return filedAway
  report(96, '核对挪走的信', `收件箱里对不上 ${gone.length} 张，正在其他文件夹里找`)

  const ids = gone.map((row) => String(row.id))
  const events = await loadLogs(ctx, ids)
  const customers = await customerFolderNames(ctx, ids)
  const warehouses = await namesOf(ctx, 'warehouses', gone.map((row) => row.warehouse_id), 'name')
  const assignees = await namesOf(ctx, 'staff', gone.map((row) => row.claimed_by), 'display_name')
  const threads = await threadMessages(ctx, ids)
  let folderNames: string[] | undefined
  try {
    folderNames = await client.folderNames()
  } catch {
    folderNames = undefined
  }
  let archived = filedAway
  let checkedGone = 0

  for (const row of gone) {
    if (checkedGone >= 8) break
    checkedGone += 1
    const ticketId = String(row.id)
    const messages = threads?.get(ticketId) ?? []
    if (messages.some((item) => item.uid && present.has(item.uid))) continue
    const messageIds = bareIds([
      typeof row.message_id === 'string' ? row.message_id : null,
      ...messages.map((item) => item.messageId),
    ])
    if (!messageIds.length) continue
    let place: { folder: string } | { status: 'missing' | 'unknown' }
    try {
      place = await locateMail(client, home, messageIds, folderNames)
    } catch {
      continue
    }
    if ('status' in place && place.status === 'unknown') continue
    if ('status' in place && place.status === 'missing') {
      await shelveTicket(ctx, row, events, customers, warehouses, assignees)
      archived += 1
      if (archived % 5 === 0) report(96, '核对挪走的信', `已留档 ${archived} 张`)
      continue
    }
    if (!('folder' in place)) continue
    if (place.folder.toLowerCase() === home.toLowerCase()) {
      const fresh = (await client.searchMessageId(messageIds[0]))[0]
      if (fresh) await ctx.admin.from('tickets').update({ imap_uid: fresh }).eq('id', ticketId)
      continue
    }
    await rememberFiling(ctx, ticketId, place.folder)
  }
  return archived
}

/** 已经记下挪去哪个文件夹的任务，只复查那个文件夹。不在了再搜整只邮箱，搜不完就留着。 */
async function confirmFiled(ctx: Context, client: Imap, home: string, report: Report) {
  const loaded = await ctx.admin
    .from('tickets')
    .select(
      'id, title, summary, status, message_id, filed_folder, from_name, from_email, received_at, warehouse_id, claimed_by, waiting_reason, priority, due_at, closed_at, facts',
    )
    .eq('mailbox', ctx.mailboxKey)
    .eq('source', 'email')
    .not('filed_folder', 'is', null)
    .limit(8)
  if (loaded.error) {
    if (/filed_folder|schema cache/i.test(loaded.error.message)) return 0
    const narrower = await ctx.admin
      .from('tickets')
      .select('id, title, summary, status, message_id, filed_folder, from_name, from_email, received_at, warehouse_id, claimed_by')
      .eq('mailbox', ctx.mailboxKey)
      .eq('source', 'email')
      .not('filed_folder', 'is', null)
      .limit(8)
    if (narrower.error) return 0
    return finishFiled(ctx, client, home, report, (narrower.data ?? []) as Record<string, unknown>[])
  }
  return finishFiled(ctx, client, home, report, (loaded.data ?? []) as Record<string, unknown>[])
}

async function finishFiled(
  ctx: Context,
  client: Imap,
  home: string,
  report: Report,
  rows: Record<string, unknown>[],
) {
  if (!rows.length) return 0
  const ids = rows.map((row) => String(row.id))
  const events = await loadLogs(ctx, ids)
  const customers = await customerFolderNames(ctx, ids)
  const warehouses = await namesOf(ctx, 'warehouses', rows.map((row) => row.warehouse_id), 'name')
  const assignees = await namesOf(ctx, 'staff', rows.map((row) => row.claimed_by), 'display_name')
  const threads = await threadMessages(ctx, ids)
  let archived = 0
  for (const row of rows) {
    const ticketId = String(row.id)
    const folder = typeof row.filed_folder === 'string' ? row.filed_folder : ''
    const messages = threads?.get(ticketId) ?? []
    const messageIds = bareIds([
      typeof row.message_id === 'string' ? row.message_id : null,
      ...messages.map((item) => item.messageId),
    ])
    if (!folder || !messageIds.length) continue
    try {
      await client.examine(folder)
      let still = false
      for (const id of messageIds) {
        if (await client.hasMessageId(id)) {
          still = true
          break
        }
      }
      if (still) continue
    } catch {
      continue
    }
    const place = await locateMail(client, home, messageIds)
    if ('status' in place && place.status === 'unknown') continue
    if ('status' in place && place.status === 'missing') {
      await shelveTicket(ctx, row, events, customers, warehouses, assignees)
      archived += 1
      if (archived % 5 === 0) report(96, '核对挪走的信', `已留档 ${archived} 张`)
      continue
    }
    if (!('folder' in place)) continue
    if (place.folder.toLowerCase() === home.toLowerCase()) {
      const fresh = (await client.searchMessageId(messageIds[0]))[0]
      await ctx.admin.from('tickets').update(fresh ? { filed_folder: null, imap_uid: fresh } : { filed_folder: null }).eq('id', ticketId)
      continue
    }
    if (place.folder.toLowerCase() !== folder.toLowerCase()) {
      await ctx.admin.from('tickets').update({ filed_folder: place.folder }).eq('id', ticketId)
    }
  }
  return archived
}

function clip(value: string | null, max: number) {
  const text = plainText(value).trim()
  if (!text) return null
  return text.length <= max ? text : text.slice(0, max)
}

function clipFacts(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const text = JSON.stringify(value)
  return text.length > 2000 ? {} : value
}

async function loadLogs(ctx: Context, ids: string[]) {
  const grouped = new Map<string, string[]>()
  for (let start = 0; start < ids.length; start += 100) {
    const slice = ids.slice(start, start + 100)
    if (!slice.length) continue
    const { data, error } = await ctx.admin
      .from('ticket_events')
      .select('ticket_id, to_status, note, created_at')
      .in('ticket_id', slice)
      .order('created_at', { ascending: true })
    if (error) throw error
    for (const row of data ?? []) {
      const id = String(row.ticket_id)
      const when = String(row.created_at ?? '').slice(0, 16).replace('T', ' ')
      const note = typeof row.note === 'string' && row.note ? ` ${row.note}` : ''
      const line = `${when} ${row.to_status ?? ''}${note}`.trim()
      const list = grouped.get(id) ?? []
      list.push(line)
      grouped.set(id, list)
    }
  }
  const logs = new Map<string, string>()
  for (const [id, lines] of grouped) {
    let text = lines.slice(-30).join('\n')
    if (text.length > 1500) text = text.slice(text.length - 1500)
    logs.set(id, text)
  }
  return logs
}

async function customerFolderNames(ctx: Context, ticketIds: string[]) {
  const map = new Map<string, string>()
  const unique = [...new Set(ticketIds.filter((id) => id.length > 0))]
  for (let start = 0; start < unique.length; start += 100) {
    const slice = unique.slice(start, start + 100)
    const { data, error } = await ctx.admin
      .from('ticket_folder_items')
      .select('ticket_id, ticket_folders(name, kind)')
      .in('ticket_id', slice)
    if (error) return map
    for (const row of data ?? []) {
      const ticketId = String(row.ticket_id ?? '')
      const folder = (Array.isArray(row.ticket_folders) ? row.ticket_folders[0] : row.ticket_folders) as
        | { name?: string; kind?: string }
        | null
      if (!ticketId || map.has(ticketId) || folder?.kind !== 'customer' || typeof folder.name !== 'string') continue
      map.set(ticketId, folder.name)
    }
  }
  return map
}

async function namesOf(ctx: Context, table: 'warehouses' | 'staff', ids: unknown[], column: 'name' | 'display_name') {
  const map = new Map<string, string>()
  const unique = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  for (let start = 0; start < unique.length; start += 100) {
    const slice = unique.slice(start, start + 100)
    const { data, error } = await ctx.admin.from(table).select(`id, ${column}`).in('id', slice)
    if (error) return map
    for (const row of data ?? []) {
      const record = row as Record<string, unknown>
      const label = record[column]
      if (typeof record.id === 'string' && typeof label === 'string') map.set(record.id, label)
    }
  }
  return map
}

/** 给还没核对过的工单记下有没有附件。缺这一列或取结构失败时，不挡更新。 */
async function noteAttachments(ctx: Context, client: Imap, uids: number[]) {
  const present = new Set(uids)
  const { data, error } = await ctx.admin
    .from('tickets')
    .select('id, imap_uid, has_attachment')
    .eq('mailbox', ctx.mailboxKey)
    .is('has_attachment', null)
  if (error) return
  const pending = (data ?? []).filter((row) => {
    const uid = Number(row.imap_uid)
    return Number.isFinite(uid) && present.has(uid)
  })
  for (let start = 0; start < pending.length; start += 50) {
    const slice = pending.slice(start, start + 50)
    const found = await client.structures(slice.map((row) => Number(row.imap_uid)))
    const yes: string[] = []
    const no: string[] = []
    for (const row of slice) {
      const has = found.get(Number(row.imap_uid))
      if (has === undefined) continue
      ;(has ? yes : no).push(String(row.id))
    }
    if (yes.length) {
      const marked = await ctx.admin.from('tickets').update({ has_attachment: true }).in('id', yes)
      if (marked.error) return
    }
    if (no.length) {
      const marked = await ctx.admin.from('tickets').update({ has_attachment: false }).in('id', no)
      if (marked.error) return
    }
  }
}

/** 「写入工单」在 30% 到 95% 之间按已处理的封数推进。取信头约占一批的七成时间。 */
const WRITE_FROM = 30
const WRITE_TO = 95
const FETCH_SHARE = 0.7

async function pullOwnMail(ctx: Context, client: Imap, follow: Array<{ ticketId: string; ids: string[] }>) {
  const result = { threaded: 0, inserted: 0 }
  let names: string[] = []
  try {
    names = await client.folderNames()
  } catch {
    return result
  }
  const sent = sentFolderName(names)
  if (!sent) return result
  await client.examine(sent)
  const rules = await customerAddresses(ctx)

  for (const job of follow) {
    for (const id of job.ids) {
      if (await messageExists(ctx, id)) continue
      const uid = (await client.searchMessageId(id))[0]
      if (!uid) continue
      const saved = await saveSentMessage(ctx, client, sent, uid, job.ticketId)
      if (saved) result.threaded += 1
    }
  }

  const mailbox = `${ctx.ourEmail}/${sent}`
  const through = await loadReceivedThrough(ctx, mailbox)
  let uids: number[] = []
  try {
    uids = await client.searchSince(searchSinceIso(through))
  } catch {
    return result
  }
  let sentTruncated = false
  if (uids.length > 800) {
    const ordered = [...uids].sort((a, b) => a - b)
    uids = [...ordered.slice(0, 400), ...ordered.slice(-400)]
    sentTruncated = true
  }
  const known = new Set<string>()
  for (let start = 0; start < uids.length; start += 100) {
    const slice = uids.slice(start, start + 100)
    const { data, error } = await ctx.admin.from('ticket_messages').select('imap_uid').eq('mailbox', mailbox).in('imap_uid', slice)
    if (error && /ticket_messages|schema cache/i.test(error.message)) return result
    if (error) break
    for (const row of data ?? []) known.add(String(row.imap_uid))
  }
  const missing = uids.filter((uid) => !known.has(String(uid))).sort((a, b) => a - b).slice(0, 40)
  let oldestSent: string | null = null
  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH)
    const raw = await client.heads(batch, HEAD_BYTES)
    const described = await client.describe(batch).catch(() => new Map<number, MessageLayout>())
    for (const uid of batch) {
      const part = raw.get(uid)
      if (!part) continue
      let head: Head
      try {
        head = await parseHead(uid, part.bytes, part.arrived)
        await ensureText(client, head, described.get(uid)?.text ?? null)
      } catch {
        continue
      }
      head.folder = sent
      if (uid === missing[0] && part.arrived) oldestSent = part.arrived
      if (head.messageId && (await messageExists(ctx, head.messageId))) {
        await rememberSpot(ctx, head)
        continue
      }
      const layout = described.get(uid)
      const parent = await findParent(ctx, head)
      if (parent) {
        const saved = await insertMessage(ctx, parent, head, layout?.files ?? [])
        if (saved === 'ok') {
          await bumpMailCount(ctx, parent)
          await markWaitingForCustomer(ctx, parent, head)
          result.threaded += 1
        } else {
          await rememberSpot(ctx, head, parent)
        }
        continue
      }
      const customer = outsideParty(ctx, head, rules)
      const taken = customer ? await subjectTicketId(ctx, head) : null
      if (!customer || taken) {
        if (taken) await rememberSpot(ctx, head, taken)
        continue
      }
      const made = ticketRow(ctx, { ...head, fromEmail: customer, fromName: null })
      const id = crypto.randomUUID()
      const madeIds = await insertTickets(ctx, [
        { ...made.row, id, from_email: customer, from_name: null, imap_uid: null, mail_count: 1 },
      ])
      if (!madeIds.includes(id)) continue
      await insertMessage(ctx, id, head, layout?.files ?? [])
      result.inserted += 1
      const asked = !head.fromEmail || head.fromEmail === ctx.ourEmail
      let parked = false
      if (asked) {
        const waiting = await ctx.admin
          .from('tickets')
          .update({ status: 'waiting', waiting_reason: 'customer' })
          .eq('id', id)
        parked = !waiting.error
      }
      const { error } = await ctx.admin.from('ticket_events').insert({
        ticket_id: id,
        from_status: null,
        to_status: parked ? 'waiting' : 'new',
        actor_id: ctx.userId,
        note: parked ? '等客户回复' : '从已发送写入',
      })
      if (error) throw error
    }
  }
  if (!sentTruncated && missing.length === 0) await saveReceivedThrough(ctx, mailbox, new Date().toISOString())
  else if (!sentTruncated && oldestSent) await saveReceivedThrough(ctx, mailbox, oldestSent)
  return result
}

/** 最新一封是我们发出去的，这张任务改成等客户。对方已经有更新的回信时不动。 */
async function markWaitingForCustomer(ctx: Context, ticketId: string, head: Head) {
  if (head.fromEmail && head.fromEmail !== ctx.ourEmail) return
  const sentAt = head.date
  if (sentAt) {
    const newer = await ctx.admin.from('ticket_messages').select('id').eq('ticket_id', ticketId).gt('received_at', sentAt).limit(1)
    if (newer.error || (newer.data ?? []).length > 0) return
  }
  const current = await ctx.admin.from('tickets').select('status, waiting_reason').eq('id', ticketId).maybeSingle()
  if (current.error || !current.data) return
  const status = typeof current.data.status === 'string' ? current.data.status : 'new'
  const reason = typeof current.data.waiting_reason === 'string' ? current.data.waiting_reason : null
  if (status === 'done' || status === 'cancelled') return
  if (status === 'waiting' && reason && reason !== 'customer') return
  if (status === 'waiting' && reason === 'customer') return
  const parked = await ctx.admin
    .from('tickets')
    .update({ status: 'waiting', waiting_reason: 'customer', updated_at: new Date().toISOString() })
    .eq('id', ticketId)
  if (parked.error) return
  await ctx.admin.from('ticket_events').insert({
    ticket_id: ticketId,
    from_status: status,
    to_status: 'waiting',
    actor_id: ctx.userId,
    note: '等客户回复',
  })
}

/** 等客户时对方回了信，任务回到可以继续办的状态。 */
async function wakeIfCustomerReplied(ctx: Context, ticketId: string, head: Head) {
  if (!head.fromEmail || head.fromEmail === ctx.ourEmail) return false
  const current = await ctx.admin.from('tickets').select('status, waiting_reason, claimed_by').eq('id', ticketId).maybeSingle()
  if (current.error || !current.data) return false
  if (current.data.status !== 'waiting' || current.data.waiting_reason !== 'customer') return false
  const next = current.data.claimed_by ? 'in_progress' : 'new'
  const woke = await ctx.admin
    .from('tickets')
    .update({ status: next, waiting_reason: null, updated_at: new Date().toISOString() })
    .eq('id', ticketId)
  if (woke.error) return false
  const { error } = await ctx.admin.from('ticket_events').insert({
    ticket_id: ticketId,
    from_status: 'waiting',
    to_status: next,
    actor_id: ctx.userId,
    note: '客户已回复',
  })
  if (error) throw error
  return true
}

async function saveSentMessage(ctx: Context, client: Imap, sent: string, uid: number, ticketId: string) {
  const raw = await client.heads([uid], HEAD_BYTES)
  const part = raw.get(uid)
  if (!part) return false
  const head = await parseHead(uid, part.bytes, part.arrived)
  head.folder = sent
  const described = await client.describe([uid]).catch(() => new Map<number, MessageLayout>())
  await ensureText(client, head, described.get(uid)?.text ?? null)
  const saved = await insertMessage(ctx, ticketId, head, described.get(uid)?.files ?? [])
  if (saved !== 'ok') return false
  await bumpMailCount(ctx, ticketId)
  await markWaitingForCustomer(ctx, ticketId, head)
  return true
}

/** 同一标题已经在某张任务上（含已完成）时，不再从已发送另开一张。返回那张任务，方便记下这封信的 UID。 */
async function subjectTicketId(ctx: Context, head: Head) {
  const wanted = bareSubject(head.subject)
  const parties = matchParties(ctx, head)
  if (!wanted || wanted === '(无主题)' || !parties.length) return null
  const { data, error } = await ctx.admin
    .from('tickets')
    .select('id, title')
    .in('from_email', parties)
    .order('received_at', { ascending: false })
    .limit(100)
  if (error) return null
  const hit = (data ?? []).find((row) => bareSubject(String(row.title ?? '')) === wanted)
  return hit ? String(hit.id) : null
}

function keepsReceivedMail(name: string, home: string) {
  if (name.toLowerCase() === home.toLowerCase()) return true
  const leaf = folderLeaf(name)
  if (/sent items|sent mail|sent messages|^sent$/i.test(leaf) || /已发送|寄件备份/.test(leaf)) return false
  if (/^drafts?$/i.test(leaf) || /草稿/.test(leaf)) return false
  if (/trash|deleted items|deleted messages/i.test(leaf) || /已删除|废件/.test(leaf)) return false
  if (/junk|spam/i.test(leaf) || /垃圾邮件|垃圾箱/.test(leaf)) return false
  if (/all mail$/i.test(leaf) || name.includes('所有邮件')) return false
  return true
}

function inHomeFolder(folder: string, home: string) {
  const name = folder.toLowerCase()
  return !folder || name === home.toLowerCase() || name === 'inbox'
}

function messageMailbox(ctx: Context, folder: string) {
  return folder && folder.toLowerCase() !== 'inbox' ? `${ctx.ourEmail}/${folder}` : ctx.mailboxKey
}

async function knownFolderUids(ctx: Context, mailbox: string, uids: number[], includeTickets: boolean) {
  const found = new Set<string>()
  for (let start = 0; start < uids.length; start += 100) {
    const slice = uids.slice(start, start + 100)
    if (!slice.length) continue
    const messages = await ctx.admin.from('ticket_messages').select('imap_uid').eq('mailbox', mailbox).in('imap_uid', slice)
    if (!messages.error) {
      for (const row of messages.data ?? []) found.add(String(row.imap_uid))
    }
    if (!includeTickets) continue
    const tickets = await ctx.admin.from('tickets').select('imap_uid').eq('mailbox', ctx.mailboxKey).in('imap_uid', slice)
    if (!tickets.error) {
      for (const row of tickets.data ?? []) found.add(String(row.imap_uid))
    }
  }
  return found
}

interface ReceivedSpot {
  folder: string
  uid: number
  arrived: number | null
}

interface FolderFrontier {
  mailbox: string
  truncated: boolean
  oldest: number | null
  undated: boolean
  empty: boolean
}

/** 各存放来信的文件夹里，还没记过的信按收信时间从早到晚。每个文件夹记下最早那封的时间。 */
async function collectReceived(ctx: Context, client: Imap, home: string) {
  let names: string[] = []
  try {
    names = await client.folderNames()
  } catch {
    names = []
  }
  const folders = names.filter((name) => keepsReceivedMail(name, home))
  if (!folders.some((name) => name.toLowerCase() === home.toLowerCase())) folders.unshift(home)
  const spots: ReceivedSpot[] = []
  const marks: FolderFrontier[] = []
  let truncated = false
  for (const name of folders) {
    try {
      await client.examine(name)
    } catch {
      continue
    }
    const mailbox = messageMailbox(ctx, inHomeFolder(name, home) ? 'inbox' : name)
    const through = await loadReceivedThrough(ctx, mailbox)
    const sinceIso = searchSinceIso(through)
    const since = Date.parse(sinceIso)
    let uids: number[] = []
    try {
      uids = await client.searchSince(sinceIso)
    } catch {
      continue
    }
    let pool = uids
    let folderTruncated = false
    if (pool.length > 800) {
      const ordered = [...pool].sort((a, b) => a - b)
      pool = [...ordered.slice(0, 400), ...ordered.slice(-400)]
      folderTruncated = true
      truncated = true
    }
    const known = await knownFolderUids(ctx, mailbox, pool, inHomeFolder(name, home))
    const fresh = pool.filter((uid) => !known.has(String(uid)))
    if (!fresh.length) {
      marks.push({ mailbox, truncated: folderTruncated, oldest: null, undated: false, empty: true })
      continue
    }
    let dates = new Map<number, string | null>()
    try {
      dates = await client.internalDates(fresh)
    } catch {
      dates = new Map()
    }
    let oldest: number | null = null
    let undated = false
    for (const uid of fresh) {
      const arrived = dates.get(uid)
      const time = arrived ? Date.parse(arrived) : null
      const dated = time !== null && !Number.isNaN(time)
      if (!dated) undated = true
      if (dated && time < since) continue
      if (dated && (oldest === null || time < oldest)) oldest = time
      spots.push({ folder: name, uid, arrived: dated ? time : null })
    }
    marks.push({ mailbox, truncated: folderTruncated, oldest, undated, empty: false })
  }
  for (const mark of marks) {
    if (mark.truncated || mark.undated || (!mark.empty && mark.oldest === null)) continue
    const iso = mark.empty ? new Date().toISOString() : new Date(mark.oldest ?? 0).toISOString()
    await saveReceivedThrough(ctx, mark.mailbox, iso)
  }
  spots.sort((a, b) => (a.arrived ?? 0) - (b.arrived ?? 0) || a.folder.localeCompare(b.folder) || a.uid - b.uid)
  return { spots, truncated }
}

function receivedTicket(ctx: Context, head: Head, home: string) {
  const made = ticketRow(ctx, head)
  if (inHomeFolder(head.folder, home)) return made
  return { ...made, row: { ...made.row, imap_uid: null, filed_folder: head.folder } }
}

/** 已经记下、正文却是空的信，每轮补写几封。补的是正文文字，不含附件。 */
async function refillBlankLetters(ctx: Context, client: Imap, home: string) {
  const { data, error } = await ctx.admin
    .from('ticket_messages')
    .select('id, ticket_id, imap_uid, imap_folder, message_id')
    .or('body.is.null,body.eq.')
    .not('message_id', 'like', 'seen:%')
    .not('imap_uid', 'is', null)
    .order('created_at', { ascending: false })
    .limit(8)
  if (error || !data?.length) return 0
  const groups = new Map<string, Array<{ id: string; ticketId: string; uid: number }>>()
  for (const row of data) {
    const uid = Number(row.imap_uid)
    if (!uid) continue
    const folder = typeof row.imap_folder === 'string' && row.imap_folder ? row.imap_folder : home
    const list = groups.get(folder) ?? []
    list.push({ id: String(row.id), ticketId: String(row.ticket_id), uid })
    groups.set(folder, list)
  }
  let filled = 0
  for (const [folder, rows] of groups) {
    try {
      await client.examine(folder)
    } catch {
      continue
    }
    const described = await client.describe(rows.map((row) => row.uid)).catch(() => new Map<number, MessageLayout>())
    for (const row of rows) {
      const head: Head = {
        uid: row.uid,
        folder,
        messageId: null,
        inReplyTo: null,
        references: null,
        subject: '',
        fromName: null,
        fromEmail: null,
        toEmails: [],
        date: null,
        summary: null,
        body: null,
        textLength: 0,
        truncated: true,
      }
      await ensureText(client, head, described.get(row.uid)?.text ?? null)
      if (!head.body) continue
      const saved = await ctx.admin.from('ticket_messages').update({ body: head.body }).eq('id', row.id)
      if (saved.error) continue
      filled += 1
      if (head.summary) {
        await ctx.admin.from('tickets').update({ summary: head.summary }).eq('id', row.ticketId).is('summary', null)
      }
    }
  }
  return filled
}

async function pull(ctx: Context, client: Imap, folder: string, report: Report): Promise<PullResult> {
  const uidValidity = await client.examine(folder)
  const listed = await client.arrivedSince(CATCHUP_SINCE)
  const threading = await messagesReady(ctx)
  const countReady = threading && (await ctx.admin.from('tickets').select('mail_count').limit(1)).error === null
  const storedByUid = await loadStored(ctx, 'imap_uid', listed.uids)
  const known = listed.uids.filter((uid) => storedByUid.has(String(uid)))
  const titleUids = known.slice(-40)
  report(WRITE_FROM, '找到新信', '正在按到达时间查看存放来信的文件夹')
  const received = await collectReceived(ctx, client, folder)
  const chosen = received.spots.slice(0, MAX_PER_RUN)
  const pendingAfter = received.spots.length - chosen.length + (received.truncated ? 1 : 0)
  const oldestMs = received.spots.find((spot) => spot.arrived !== null)?.arrived ?? null
  const when = oldestMs === null ? '' : sydneyWhen(oldestMs)
  report(
    WRITE_FROM,
    '找到新信',
    [
      received.spots.length
        ? pendingAfter
          ? `还有 ${received.spots.length} 封没记过${when ? `，最早是 ${when}` : ''}，这次从这封往后写 ${chosen.length} 封`
          : `还有 ${received.spots.length} 封没记过${when ? `，最早是 ${when}` : ''}`
        : '没有还没记过的来信',
      known.length ? `另外核对最近 ${titleUids.length} 封已有工单的标题` : '',
    ]
      .filter(Boolean)
      .join('。'),
  )

  const total = chosen.length + titleUids.length
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
    archived: 0,
    threaded: 0,
    oldest: oldestMs === null ? null : new Date(oldestMs).toISOString(),
  }
  const follow: Array<{ ticketId: string; ids: string[] }> = []
  const note = () => `新建 ${result.inserted} 单，并入 ${result.threaded ?? 0} 封，标题更新 ${result.updated} 张`

  for (let start = 0; start < chosen.length; start += BATCH) {
    const slice = chosen.slice(start, start + BATCH)
    const files = new Map<string, MessageFile[]>()
    const byFolder = new Map<string, number[]>()
    for (const spot of slice) {
      const list = byFolder.get(spot.folder) ?? []
      list.push(spot.uid)
      byFolder.set(spot.folder, list)
    }
    const prepared = new Map<string, Head>()
    for (const [name, uids] of byFolder) {
      try {
        await client.examine(name)
        const fetched = await client.heads(uids, HEAD_BYTES)
        const described = await client.describe(uids).catch(() => new Map<number, MessageLayout>())
        for (const uid of uids) {
          const part = fetched.get(uid)
          if (!part) continue
          files.set(`${name}\0${uid}`, described.get(uid)?.files ?? [])
          try {
            const head = await parseHead(uid, part.bytes, part.arrived)
            head.folder = name
            await ensureText(client, head, described.get(uid)?.text ?? null)
            prepared.set(`${name}\0${uid}`, head)
          } catch {
            // 这封拆失败，下面按没取到计数
          }
        }
      } catch {
        // 这个文件夹这次没取到，下一次再试
      }
    }
    result.scanned += slice.length
    done += slice.length
    report(at(done), '写入工单', `已取回 ${done} / ${total} 封。${note()}`)

    const heads: Head[] = []
    for (const spot of slice) {
      const head = prepared.get(`${spot.folder}\0${spot.uid}`)
      if (!head) {
        result.skipped += 1
        continue
      }
      heads.push(head)
    }

    const byMessage = await loadStored(
      ctx,
      'message_id',
      heads.map((head) => head.messageId).filter((id): id is string => Boolean(id)),
    )
    const seenIds = new Set<string>()
    const fresh: Array<ReturnType<typeof ticketRow> & { id: string; head: Head }> = []
    for (const head of heads) {
      const same = head.messageId ? byMessage.get(head.messageId) : undefined
      if (same) {
        await rememberSpot(ctx, head, same.id)
        if (!inHomeFolder(head.folder, folder)) {
          result.skipped += 1
          continue
        }
        if (await updateStored(ctx, same, head)) result.updated += 1
        else result.skipped += 1
        continue
      }
      if (head.messageId && seenIds.has(head.messageId)) {
        await rememberSpot(ctx, head)
        result.skipped += 1
        continue
      }
      if (head.messageId) seenIds.add(head.messageId)
      if (threading) {
        const parent = await findParent(ctx, head)
        if (parent) {
          const saved = await insertMessage(ctx, parent, head, files.get(`${head.folder}\0${head.uid}`) ?? [])
          if (saved === 'ok') {
            await bumpMailCount(ctx, parent)
            const woke = await wakeIfCustomerReplied(ctx, parent, head)
            if (!woke) {
              const current = await ctx.admin.from('tickets').select('status').eq('id', parent).maybeSingle()
              const status = typeof current.data?.status === 'string' ? current.data.status : 'new'
              const { error } = await ctx.admin.from('ticket_events').insert({
                ticket_id: parent,
                from_status: status,
                to_status: status,
                actor_id: ctx.userId,
                note: '收到后续邮件',
              })
              if (error) throw error
            }
            result.threaded = (result.threaded ?? 0) + 1
            const ids = referencedIds(head)
            if (ids.length) follow.push({ ticketId: parent, ids })
          } else {
            await rememberSpot(ctx, head)
            result.skipped += 1
          }
          continue
        }
        const made = receivedTicket(ctx, head, folder)
        const id = crypto.randomUUID()
        const madeIds = await insertTickets(ctx, [{ ...made.row, id, ...(countReady ? { mail_count: 1 } : {}) }])
        if (!madeIds.includes(id)) {
          await rememberSpot(ctx, head)
          result.skipped += 1
          continue
        }
        await insertMessage(ctx, id, head, files.get(`${head.folder}\0${head.uid}`) ?? [])
        result.inserted += 1
        const ids = referencedIds(head)
        if (ids.length) follow.push({ ticketId: id, ids })
        if (made.isNewSender) result.newSenders += 1
        const { error } = await ctx.admin.from('ticket_events').insert({
          ticket_id: id,
          from_status: null,
          to_status: 'new',
          actor_id: ctx.userId,
          note: '从邮箱写入',
        })
        if (error) throw error
        continue
      }
      const made = receivedTicket(ctx, head, folder)
      fresh.push({ ...made, id: crypto.randomUUID(), head })
    }

    if (!threading) {
    const ids = await insertTickets(
      ctx,
      fresh.map((item) => ({ ...item.row, id: item.id })),
    )
    const madeIds = new Set(ids)
    result.inserted += ids.length
    result.skipped += fresh.length - ids.length
    result.newSenders += fresh.filter((item) => madeIds.has(item.id) && item.isNewSender).length
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
    }
    result.pending = pendingAfter + (chosen.length - (start + slice.length))
    report(at(done), '写入工单', `已处理 ${done} / ${total} 封。${note()}`)
  }

  try {
    await client.examine(folder)
  } catch {
    // 回到收件箱失败时，标题核对会自己跳过
  }
  for (let start = 0; start < titleUids.length; start += BATCH) {
    const batch = titleUids.slice(start, start + BATCH)
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
      const described = await client.describe(changed).catch(() => new Map<number, MessageLayout>())
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
          await ensureText(client, head, described.get(uid)?.text ?? null)
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

  if (threading) {
    try {
      const own = await pullOwnMail(ctx, client, follow)
      result.threaded = (result.threaded ?? 0) + own.threaded
      result.inserted += own.inserted
    } catch {
      // 已发送没读到，不挡收件箱这次更新
    }
    try {
      await client.examine(folder)
    } catch {
      // 回到收件箱失败时，后面的附件标记和归档会自己跳过
    }
  }

  if (threading) {
    try {
      const filled = await refillBlankLetters(ctx, client, folder)
      if (filled) report(94, '写入工单', `补上 ${filled} 封原先没有正文的信`)
    } catch {
      // 空正文没补上，下一轮再试
    }
    try {
      await client.examine(folder)
    } catch {
      // 回到收件箱失败时，后面的附件标记会自己跳过
    }
  }

  try {
    await noteAttachments(ctx, client, listed.uids)
  } catch {
    // 附件标记没写上，不挡这次更新
  }
  report(96, '核对挪走的信', '正在核对已经不在收件箱里的工单')
  result.archived = await retireMissing(ctx, client, folder, listed, report)
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
