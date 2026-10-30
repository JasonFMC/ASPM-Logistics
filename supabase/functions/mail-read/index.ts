// 打开工单时读一封原信。函数只做三件事：
// 1. 核对 14 天缓存，有就直接给页面。
// 2. 没有缓存时，从邮箱取出整封原文，原样传给页面。拆信（编码、正文、内嵌图、附件）在浏览器里做。
// 3. 页面拆好以后把正文送回来，这里写进 14 天缓存。附件不进缓存。
// 邮箱以只读方式打开，不会把邮件标成已读。
//
// 读信的回复是一串帧，每行一个 JSON：进度、{"source": 总字节}、{"chunk": n}。
// {"chunk": n} 这一行后面紧跟 n 个字节的原文。原文边从邮箱收边转给页面，不在函数里攒整封；
// 传到一半出错时，错误仍是单独一行。
//
// 邮箱连接用 Deno 自带的 TLS 和下面的最小 IMAP 客户端，不用 imapflow：
// imapflow 在 Edge Runtime 的 Node 兼容 TLS 上收不完长回复，正文会一直卡住。
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

/** 超过这个大小的信不在页面里打开，用 Outlook 看。 */
const SOURCE_MAX = 25_000_000
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

  async examine(folder: string) {
    await this.run(['EXAMINE ', astring(folder)])
  }

  /** 这封信的大小（字节）。信已不在邮箱里时返回 null。 */
  async size(uid: number) {
    const lines = await this.run([`UID FETCH ${uid} (RFC822.SIZE)`])
    for (const line of lines) {
      const match = line.match(/RFC822\.SIZE (\d+)/i)
      if (match) return Number(match[1])
    }
    return null
  }

  /** 取整封原文。onStart 先拿到总字节数，onChunk 按块收内容。 */
  async source(uid: number, onStart: (size: number) => void, onChunk: (chunk: Uint8Array) => void) {
    let got = false
    await this.run([`UID FETCH ${uid} BODY.PEEK[]`], async (size) => {
      got = true
      onStart(size)
      await this.readExact(size, onChunk)
    })
    if (!got) throw new Error('邮箱里已经没有这封信')
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

async function loadTicket(admin: SupabaseClient, ticketId: string) {
  const { data, error } = await admin
    .from('tickets')
    .select('imap_uid, received_at')
    .eq('id', ticketId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error('找不到这张工单')
  return data as { imap_uid: number | null; received_at: string | null }
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

async function readLetter(admin: SupabaseClient, ticketId: string, fresh: boolean, send: Send) {
  send.frame({ pct: 10, step: '已接到请求' })
  if (!fresh) {
    const cached = await loadCache(admin, ticketId)
    if (cached) {
      send.frame({ pct: 100, step: '查到缓存', letter: cached })
      return
    }
  }
  const ticket = await loadTicket(admin, ticketId)
  if (!ticket.imap_uid) {
    send.frame({ pct: 100, step: '读完正文', letter: null })
    return
  }
  send.frame({ pct: 20, step: '已核对缓存' })

  const { host, user, pass, port, folder } = mailboxConfig()
  const client = await Imap.open(host, port)
  try {
    await client.login(user, pass)
    await client.examine(folder)
    send.frame({ pct: 30, step: '连上邮箱' })
    const size = await client.size(ticket.imap_uid)
    if (size === null) throw new Error('邮箱里已经没有这封信')
    if (size > SOURCE_MAX) {
      throw new Error(`这封信有 ${Math.round(size / 1_000_000)} MB，请用「打开原邮件」在 Outlook 里看。`)
    }
    send.frame({ pct: 40, step: '取到信', size })
    await client.source(
      ticket.imap_uid,
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
  return json({ saved: true })
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

  let body: { ticketId?: string; fresh?: boolean; cache?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: '缺少工单' }, 400)
  }
  const ticketId = body.ticketId?.trim() ?? ''
  if (!ticketId) return json({ error: '缺少工单' }, 400)

  const admin = createClient(supabaseUrl, serviceKey)
  if (body.cache !== undefined) {
    try {
      return await saveCache(admin, ticketId, body.cache)
    } catch (err) {
      return json({ error: messageOf(err) }, 500)
    }
  }
  return frameResponse((send) => readLetter(admin, ticketId, body.fresh === true, send))
})
