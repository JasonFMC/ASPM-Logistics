import PostalMime, { type Address, type Email } from 'postal-mime'
import { supabase } from './supabase'

/**
 * 打开工单时读原信。
 * mail-read 只负责从邮箱取出整封原文；这里在浏览器里拆信：转编码、取正文、嵌入内嵌图、留下附件。
 * 拆好的正文送回 mail-read 存 14 天；附件只留在这次打开的页面里。
 */

export interface MailFile {
  index: number
  name: string
  type: string
  size: number
}

export interface MailLetter {
  format?: number
  from: string
  to: string
  cc: string
  subject: string
  date: string | null
  html: string
  attachments: MailFile[]
}

export interface MailReadProgress {
  pct: number
  step: string
}

/**
 * 进度条上的步骤。缓存里有这封信时只走前两步。
 * 「取回正文」从 45% 走到 95%，按从邮箱实际收到的字节数推进。
 */
export const MAIL_STEPS = [
  { pct: 10, step: '已接到请求' },
  { pct: 20, step: '已核对缓存' },
  { pct: 30, step: '连上邮箱' },
  { pct: 40, step: '取到信' },
  { pct: 45, step: '取回正文' },
  { pct: 100, step: '读完正文' },
]

const SOURCE_FROM = 45
const SOURCE_TO = 95

export const MAIL_CACHE_STEPS = [
  { pct: 10, step: '已接到请求' },
  { pct: 100, step: '查到缓存' },
]

interface Frame {
  pct?: number
  step?: string
  size?: number
  source?: number
  chunk?: number
  letter?: MailLetter | null
  error?: string
}

interface OpenedMail {
  letter: MailLetter
  files: Blob[]
  /** 正文里的电子签名和粘贴图。不出现在附件列表里，点链接时按文件名取出。 */
  linked: Map<string, Blob>
  /** 写在署名之后的图。正文里粘贴的图不放这里。 */
  signatures: Blob[]
  /** 按原信段落排好的正文，图片在它原来的位置写成 [image:文件名]。 */
  flowText: string
  /** 出现在署名之后的图，按原信里的先后，不看文件名。 */
  signatureNames: string[]
}

type Progress = (update: MailReadProgress) => void

/** 拆信规则变了就加一。缓存里旧规则拆出的信会重新从邮箱取，附件序号才对得上。 */
const LETTER_FORMAT = 5

function fileBase(value: string) {
  return value.split(/[/\\]/).pop()?.split('?')[0]?.split('@')[0]?.trim().toLowerCase() ?? ''
}

/** 邮箱署名里的小图标。image001.png 是贴进正文的图，不是署名。 */
function signatureAssetName(value: string) {
  const base = fileBase(value)
  if (!base) return false
  return /^(?:logo\d*|signature\d*|sign|sig|badge|banner|icon|outlook-[\w.-]+|~wrd\d+|mobilephone|emailaddress|website|address|phone|email|fax|linkedin|facebook|twitter|youtube|instagram)(?:\.(?:png|jpe?g|gif))?$/.test(base)
}

function genericSignatureName(value: string) {
  return signatureAssetName(value)
}

function signoffAt(body: string) {
  let offset = 0
  const lines = body.split('\n')
  let found = -1
  for (const line of lines) {
    const text = line.trim().replace(/[,，.。]+$/g, '')
    if (/^(?:thanks|thank you|kind regards|best regards|warm regards|regards|cheers|sincerely)$/i.test(text)) found = offset
    offset += line.length + 1
  }
  return found
}

function mentionAt(body: string, fileName: string) {
  const stem = fileBase(fileName).replace(/\.[^.]+$/, '')
  if (stem.length < 3) return -1
  return body.toLowerCase().lastIndexOf(stem.toLowerCase())
}

function pastedImageName(value: string) {
  const base = fileBase(value)
  if (!base || signatureAssetName(base)) return false
  return /^(?:image\d+|screenshot\d*|clipboard\d*|pastedimage\d*)(?:\.(?:png|jpe?g|gif|webp|bmp))?$/.test(base)
    || /image\d+\.(?:png|jpe?g|gif)/.test(base)
    || /截图|粘贴/.test(base)
}

/** 署名用的小图标，不计入附件。 */
export function isSignatureFile(file: { name: string; type: string; size: number }) {
  if (!signatureAssetName(file.name)) return false
  return file.size <= 1_500_000
}

/** 正文里粘贴、由邮箱自动起名的图片，不计入附件。 */
export function isPastedFile(file: { name: string; type: string; size: number }) {
  return pastedImageName(file.name)
}

function looksLikeImage(file: { name: string; type: string }) {
  const base = fileBase(file.name)
  const extension = base.includes('.') ? base.split('.').pop() ?? '' : ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) return true
  if (file.type.startsWith('image/')) return true
  return /^image\d*$/.test(base.replace(/\.[^.]+$/, ''))
}

/**
 * 署名图在发件人姓名之后。姓名之前的内嵌图留在正文。
 * 正文没写到文件名时，不把图收进署名。
 */
export function isTrailingSignatureImage(file: { name: string; type: string; size: number }, body: string) {
  if (isSignatureFile(file) || isPastedFile(file) || file.size > 1_500_000) return false
  if (!looksLikeImage(file)) return false
  const at = mentionAt(body, file.name)
  const sign = signoffAt(body)
  if (at < 0 || sign < 0) return false
  return at > sign
}

/** 贴进正文的图：正文里还留着它的位置。没贴进正文的附件不算。 */
function imageSitsInBody(fileName: string, body: string) {
  const base = fileBase(fileName)
  const stem = base.replace(/\.[^.]+$/, '')
  if (stem.length < 3) return false
  const lower = body.toLowerCase()
  if (lower.includes(`[image:${stem}`) || lower.includes(`[image:${base}`) || lower.includes(`<${base}>`)) return true
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[(?:cid:)?[^\\]\\n]*${escaped}(?:\\.(?:png|jpe?g|gif))?@[^\\]\\n]*\\]`, 'i').test(body)
    || new RegExp(`(?:^|\\n)[^\\n]*${escaped}\\.(?:png|jpe?g|gif)@[^\\n]*(?:\\n|$)`, 'i').test(body)
}

/** 只看正文里有没有这张图的位置，不看文件名。 */
export function isInlineBodyImage(file: { name: string; type: string; size: number }, body: string) {
  return imageSitsInBody(file.name, body)
}

const KEEP_OPENED = 5
const opened = new Map<string, OpenedMail>()
const cachedLetters = new Map<string, MailLetter | null>()

/** 标题已随邮箱改过。丢掉本页记住的原信，下次打开再从邮箱取。 */
export function clearMailCache() {
  opened.clear()
  cachedLetters.clear()
}

function remember(ticketId: string, mail: OpenedMail) {
  opened.delete(ticketId)
  opened.set(ticketId, mail)
  while (opened.size > KEEP_OPENED) {
    const oldest = opened.keys().next().value
    if (oldest === undefined) break
    opened.delete(oldest)
  }
}

async function callMailRead(body: Record<string, unknown>, signal?: AbortSignal) {
  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!token || !supabaseUrl || !anonKey) throw new Error('未登录')
  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/mail-read`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: anonKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err
    throw new Error('浏览器没有连上取信服务，请检查网络后刷新。')
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
    throw new Error(`取信服务回复 ${response.status}：${message || response.statusText}`)
  }
  return response
}

function encodeHandoff(value: string) {
  const bytes = new TextEncoder().encode(value)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** 让本机 Outlook 打开这一封信的原文。不传 messageId 时打开任务上的第一封。 */
export async function openOriginalMail(ticketId: string, messageId?: string) {
  const response = await callMailRead({ ticketId, messageId, intent: 'outlook' })
  const type = response.headers.get('content-type') || ''
  if (!type.includes('application/json')) {
    throw new Error('取信服务还是旧的。请把 mail-read 的代码贴到 Supabase 后再试。')
  }
  const payload = (await response.json()) as { token?: string; error?: string }
  if (!payload.token) throw new Error(payload.error || '没有拿到打开凭据')
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!supabaseUrl || !anonKey) throw new Error('未登录')
  const link = `aspm-mail:${encodeHandoff(JSON.stringify({ url: supabaseUrl.replace(/\/$/, ''), key: anonKey, token: payload.token }))}`
  window.location.assign(link)
}

function joinBytes(chunks: Uint8Array[], total: number) {
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.length
  }
  return joined
}

/**
 * 读 mail-read 的回复。每行一个 JSON 帧；{"chunk": n} 这一行后面紧跟 n 个字节的原文，
 * 收完再回到读行。原文传到一半出错时，错误仍是单独一行，能读出原因。
 */
async function readFrames(response: Response, onProgress: Progress) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('取信服务没有回复内容')
  const decoder = new TextDecoder()
  let pending: Uint8Array = new Uint8Array(0)
  let lastStep = '正在送出请求'
  let letter: MailLetter | null | undefined
  let sourceSize = -1
  const sourceChunks: Uint8Array[] = []
  let received = 0
  let chunkLeft = 0

  const takeSource = (bytes: Uint8Array) => {
    sourceChunks.push(bytes)
    received += bytes.length
    chunkLeft -= bytes.length
    const share = sourceSize > 0 ? Math.min(1, received / sourceSize) : 1
    onProgress({ pct: SOURCE_FROM + Math.floor(share * (SOURCE_TO - SOURCE_FROM)), step: '取回正文' })
  }

  const handle = (frame: Frame) => {
    if (frame.error) throw new Error(frame.error)
    if (typeof frame.pct === 'number' && frame.step) {
      lastStep = frame.step
      onProgress({ pct: frame.pct, step: frame.step })
    }
    if ('letter' in frame) letter = frame.letter ?? null
    if (typeof frame.source === 'number') sourceSize = frame.source
    if (typeof frame.chunk === 'number') chunkLeft = frame.chunk
  }

  const consume = (incoming: Uint8Array) => {
    let bytes = incoming
    while (bytes.length) {
      if (chunkLeft > 0) {
        const take = Math.min(chunkLeft, bytes.length)
        takeSource(bytes.slice(0, take))
        bytes = bytes.subarray(take)
        continue
      }
      const newline = bytes.indexOf(10)
      if (newline < 0) {
        pending = pending.length ? joinBytes([pending, bytes], pending.length + bytes.length) : bytes.slice()
        return
      }
      const lineBytes = pending.length
        ? joinBytes([pending, bytes.subarray(0, newline)], pending.length + newline)
        : bytes.subarray(0, newline)
      pending = new Uint8Array(0)
      bytes = bytes.subarray(newline + 1)
      const line = decoder.decode(lineBytes).trim()
      if (line) handle(JSON.parse(line) as Frame)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    consume(value)
  }

  if (letter !== undefined) return { letter }
  if (sourceSize < 0) throw new Error(`读到「${lastStep}」后取信服务断开了，没有说明原因。`)
  if (received < sourceSize) {
    throw new Error(`原文只收到 ${received} / ${sourceSize} 字节，连接就断开了。`)
  }
  return { source: joinBytes(sourceChunks, received) }
}

function formatAddresses(list: Address[] | Address | undefined) {
  const items = Array.isArray(list) ? list : list ? [list] : []
  const flat = items.flatMap((item) => (item.group ? item.group : [item]))
  return flat
    .map((item) => {
      const name = item.name?.trim()
      const address = item.address?.trim()
      if (name && address) return `${name} <${address}>`
      return address || name || ''
    })
    .filter(Boolean)
    .join(', ')
}

function escapeHtml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function cidOf(value: string) {
  return value.replace(/^cid:/i, '').replace(/^<|>$/g, '').trim().toLowerCase()
}

const BLOCKED_TAGS = 'script, iframe, frame, frameset, object, embed, applet, form, link, base, meta[http-equiv]'
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'background'])

function byteLength(content: unknown) {
  if (content instanceof Uint8Array || content instanceof ArrayBuffer) return content.byteLength
  if (typeof content === 'string') return content.length
  return 0
}

/** 署名之后的图片。姓名前面的粘贴图不算。 */
function cidsAfterSignoff(html: string) {
  const found = new Set<string>()
  if (!html) return found
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = doc.body
  if (!root) return found
  let signoff: Node | null = null
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().replace(/[,，.。]+$/g, '')
    if (/^(?:thanks|thank you|kind regards|best regards|warm regards|regards|cheers|sincerely)$/i.test(text)) signoff = node
    node = walker.nextNode()
  }
  if (!signoff) return found
  doc.querySelectorAll('img').forEach((image) => {
    if ((signoff.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) return
    const src = image.getAttribute('src') ?? ''
    const cid = /^cid:/i.test(src) ? cidOf(src) : ''
    if (cid) found.add(cid)
  })
  return found
}

/** 按原信 HTML 的阅读顺序写出正文。图片留在它所在的那一段，署名之后的图不写进正文。 */
function flowFromHtml(html: string, nameByCid: Map<string, string>, signatureCids: Set<string>) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const root = doc.body
  if (!root) return ''
  const parts: string[] = []
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'HEAD') return
    if (tag === 'IMG') {
      const src = element.getAttribute('src') ?? ''
      const cid = /^cid:/i.test(src) ? cidOf(src) : ''
      const name = cid ? nameByCid.get(cid) : ''
      if (name && cid && !signatureCids.has(cid)) parts.push(`\n[image:${name}]\n`)
      return
    }
    if (tag === 'BR') {
      parts.push('\n')
      return
    }
    for (const child of element.childNodes) walk(child)
    if (/^(P|DIV|TR|LI|H[1-6]|TABLE|BLOCKQUOTE)$/.test(tag)) parts.push('\n')
  }
  walk(root)
  return parts.join('').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 原信 HTML 只保留版式和内容：去掉脚本、外链、事件。署名和粘贴图只留链接。 */
function cleanHtml(raw: string, inline: Map<string, string>, marked: Map<string, { name: string; caption: string }>) {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll(BLOCKED_TAGS).forEach((node) => node.remove())
  doc.querySelectorAll('*').forEach((element) => {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith('on')) element.removeAttribute(attr.name)
      else if (URL_ATTRS.has(name) && /^\s*(javascript|vbscript):/i.test(attr.value)) element.removeAttribute(attr.name)
    }
  })
  doc.querySelectorAll('img[src]').forEach((image) => {
    const src = image.getAttribute('src') ?? ''
    const cid = /^cid:/i.test(src) ? cidOf(src) : ''
    const mark = cid ? marked.get(cid) : undefined
    const httpSrc = /^https?:\/\//i.test(src.trim()) ? src.trim() : ''
    const httpCaption = httpSrc && genericSignatureName(httpSrc) ? '电子签名' : httpSrc && pastedImageName(httpSrc) ? '粘贴的图片' : ''
    if (!mark && !httpCaption) {
      if (!cid) return
      const data = inline.get(cid)
      if (data) image.setAttribute('src', data)
      return
    }
    const parent = image.parentElement
    const parentHref = parent?.tagName === 'A' ? (parent.getAttribute('href') ?? '').trim() : ''
    const href = /^https?:\/\//i.test(parentHref) ? parentHref : httpSrc
    const label = href || mark?.name || '图片'
    const caption = mark?.caption || httpCaption
    const fragment = doc.createDocumentFragment()
    if (href) {
      const link = doc.createElement('a')
      link.setAttribute('href', href)
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener noreferrer')
      link.textContent = label
      fragment.append(link, doc.createTextNode(` ${caption}`))
    } else {
      fragment.append(doc.createTextNode(`${label} ${caption}`))
    }
    if (parent?.tagName === 'A' && parent.childNodes.length === 1) parent.replaceWith(fragment)
    else image.replaceWith(fragment)
  })
  doc.querySelectorAll('a[href]').forEach((link) => {
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  })
  return `<!doctype html>${doc.documentElement.outerHTML}`
}

function plainHtml(text: string) {
  return `<!doctype html><html><body><pre style="white-space:pre-wrap;font-family:Segoe UI,sans-serif;margin:0">${escapeHtml(text)}</pre></body></html>`
}

const EXTENSION_OF: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip',
  'application/vnd.ms-outlook': 'msg',
  'message/rfc822': 'eml',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/calendar': 'ics',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
}

/** 附件没写文件名时：转来的邮件用它的标题，其他按类型补后缀。 */
async function nameOf(part: Email['attachments'][number], order: number) {
  if (part.filename?.trim()) return part.filename.trim()
  const extension = EXTENSION_OF[part.mimeType] ?? part.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? ''
  if (part.mimeType === 'message/rfc822') {
    try {
      const inner = await PostalMime.parse(part.content as ArrayBuffer)
      const subject = inner.subject?.trim().replace(/[\\/:*?"<>|]/g, '_')
      if (subject) return `${subject}.eml`
    } catch {
      // 拆不开就用默认名
    }
  }
  return extension ? `附件 ${order}.${extension}` : `附件 ${order}`
}

async function unpack(source: Uint8Array): Promise<OpenedMail> {
  let email: Email
  try {
    email = await PostalMime.parse(source, { forceRfc822Attachments: true })
  } catch (err) {
    throw new Error(`原文拆不开：${err instanceof Error ? err.message : '格式不对'}`)
  }

  const html = email.html ?? ''
  const signatureCids = cidsAfterSignoff(html)
  const referenced = new Set(Array.from(html.matchAll(/cid:([^"'\s)>]+)/gi), (match) => cidOf(match[1])))
  const inline = new Map<string, string>()
  const marked = new Map<string, { name: string; caption: string }>()
  const files: Blob[] = []
  const attachments: MailFile[] = []
  const linked = new Map<string, Blob>()
  const signatures: Blob[] = []
  const nameByCid = new Map<string, string>()
  const keepLinked = (name: string, blob: Blob) => {
    const key = name.trim().toLowerCase()
    if (key && !linked.has(key)) linked.set(key, blob)
    const mark = key.match(/image\d{1,3}\.(?:png|jpe?g|gif)/)?.[0]
    if (mark && !linked.has(mark)) linked.set(mark, blob)
  }

  for (const part of email.attachments) {
    const type = part.mimeType || 'application/octet-stream'
    const blob = new Blob([part.content as BlobPart], { type })
    const cid = part.contentId ? cidOf(part.contentId) : ''
    const name = part.filename?.trim() || (cid ? cid.split('@')[0] : '')
    const described = { name, type, size: byteLength(part.content) || blob.size }
    if (cid && name) nameByCid.set(cid, name)
    if (cid && signatureCids.has(cid)) {
      signatures.push(blob)
      marked.set(cid, { name: name || '签名', caption: '电子签名' })
      keepLinked(name || '签名', blob)
      if (cid) keepLinked(cid.split('@')[0], blob)
      continue
    }
    if (cid && referenced.has(cid) && isSignatureFile(described)) {
      signatures.push(blob)
      marked.set(cid, { name: name || '签名', caption: '电子签名' })
      keepLinked(name || '签名', blob)
      if (cid) keepLinked(cid.split('@')[0], blob)
      continue
    }
    if (cid && referenced.has(cid) && (isPastedFile(described) || type.startsWith('image/'))) {
      marked.set(cid, { name: name || '图片', caption: '粘贴的图片' })
      keepLinked(name || '图片', blob)
      if (cid) keepLinked(cid.split('@')[0], blob)
      continue
    }
    attachments.push({
      index: files.length,
      name: await nameOf(part, files.length + 1),
      type,
      size: blob.size,
    })
    files.push(blob)
  }

  const body = html
    ? cleanHtml(html, inline, marked)
    : email.text
      ? plainHtml(email.text)
      : plainHtml('这封信没有正文。')

  const date = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null
  return {
    letter: {
      format: LETTER_FORMAT,
      from: formatAddresses(email.from),
      to: formatAddresses(email.to),
      cc: formatAddresses(email.cc),
      subject: email.subject?.trim() || '',
      date,
      html: body,
      attachments,
    },
    files,
    linked,
    signatures,
    flowText: html ? flowFromHtml(html, nameByCid, signatureCids) : '',
    signatureNames: [...signatureCids].map((cid) => nameByCid.get(cid) ?? '').filter(Boolean),
  }
}

/** 取出这封信，按原信段落给出正文和署名图。位置来自原信版式，不看文件名。 */
export async function loadMessageFlow(ticketId: string, messageId: string) {
  const cached = opened.get(`m:${messageId}`)
  if (cached) return { text: cached.flowText, signatureNames: cached.signatureNames }
  const mail = await openFromMailbox(ticketId, () => undefined, undefined, messageId)
  return { text: mail.flowText, signatureNames: mail.signatureNames }
}

function fileBlob(mail: OpenedMail, file: MailFile) {
  const named = mail.letter.attachments.find((item) => item.name.trim().toLowerCase() === file.name.trim().toLowerCase())
  if (named) {
    const blob = mail.files[named.index]
    if (blob) return { blob, shown: named }
  }
  const linked = mail.linked.get(file.name.trim().toLowerCase())
  if (linked) return { blob: linked, shown: file }
  return null
}

/** 从邮箱取出整封原文并拆开。不看缓存。 */
async function openFromMailbox(ticketId: string, onProgress: Progress, signal?: AbortSignal, messageId?: string) {
  const response = await callMailRead({ ticketId, messageId, fresh: true }, signal)
  const reply = await readFrames(response, onProgress)
  if (!reply.source) throw new Error('这张工单没有对应的邮件')
  const mail = await unpack(reply.source)
  const key = messageId ? `m:${messageId}` : ticketId
  remember(key, mail)
  if (!messageId) saveLetter(ticketId, mail.letter)
  return mail
}

function saveLetter(ticketId: string, letter: MailLetter) {
  void callMailRead({ ticketId, cache: letter }).catch(() => undefined)
}

/** 打开工单时读原信。先看 14 天缓存，没有再去邮箱取整封原文。 */
export async function readMailLetter(ticketId: string, onProgress: Progress, signal?: AbortSignal) {
  const inPage = opened.get(ticketId)
  if (inPage) {
    onProgress({ pct: 100, step: '读完正文' })
    return inPage.letter
  }
  if (cachedLetters.has(ticketId)) {
    onProgress({ pct: 100, step: '查到缓存' })
    return cachedLetters.get(ticketId) ?? null
  }

  const response = await callMailRead({ ticketId }, signal)
  const reply = await readFrames(response, onProgress)
  if (reply.letter !== undefined && (reply.letter === null || reply.letter.format === LETTER_FORMAT)) {
    cachedLetters.set(ticketId, reply.letter)
    return reply.letter
  }
  const mail = reply.source ? await unpack(reply.source) : await openFromMailbox(ticketId, onProgress, signal)
  onProgress({ pct: 100, step: '读完正文' })
  remember(ticketId, mail)
  saveLetter(ticketId, mail.letter)
  return mail.letter
}

const VIEWER_STYLE = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; font: 14px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; color: #0f172a; background: #f1f5f9; }
header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #fff; border-bottom: 1px solid #e2e8f0; }
header strong { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.status { color: #64748b; }
.status.error { color: #b91c1c; }
.download { padding: 6px 14px; border-radius: 8px; background: #0f766e; color: #fff; font-weight: 700; text-decoration: none; white-space: nowrap; }
.download.small { padding: 2px 10px; font-size: 12px; }
main { flex: 1; min-height: 0; overflow: auto; }
iframe.fill { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.image { display: flex; justify-content: center; padding: 16px; }
.image img { max-width: 100%; height: auto; background: #fff; }
pre { margin: 16px; padding: 16px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.note { max-width: 32rem; margin: 48px auto; padding: 24px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; text-align: center; }
.mail { display: flex; flex-direction: column; height: 100%; }
.mail dl { display: grid; grid-template-columns: 4.5rem 1fr; gap: 4px 8px; margin: 0; padding: 12px 16px; background: #fff; border-bottom: 1px solid #e2e8f0; }
.mail dt { color: #64748b; }
.mail dd { margin: 0; overflow-wrap: anywhere; }
.mail ul { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mail li { display: flex; align-items: center; gap: 6px; }
.mail iframe { flex: 1; min-height: 0; }
`

type ViewKind = 'pdf' | 'image' | 'text' | 'html' | 'mail' | 'other'

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}
const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'log', 'json', 'xml', 'ics'])

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 文件名没有后缀时，用文件头判断是不是图片或 PDF。 */
function sniffType(bytes: Uint8Array) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'application/pdf'
  }
  return null
}

/** 先看扩展名：不少发件人把附件一律标成 application/octet-stream。 */
function viewKindOf(file: MailFile): ViewKind {
  const extension = extensionOf(file.name)
  if (extension === 'pdf' || file.type === 'application/pdf') return 'pdf'
  if (IMAGE_TYPES[extension] || Object.values(IMAGE_TYPES).includes(file.type)) return 'image'
  if (extension === 'eml' || file.type === 'message/rfc822') return 'mail'
  if (extension === 'html' || extension === 'htm' || file.type === 'text/html') return 'html'
  if (TEXT_EXTENSIONS.has(extension) || file.type.startsWith('text/')) return 'text'
  return 'other'
}

/** 新标签页里的查看页。地址生在新标签页里，原工单页关掉后下载按钮仍然有效。 */
function makeViewer(tab: Window, name: string) {
  const doc = tab.document
  const tabUrl = (tab as unknown as typeof globalThis).URL
  doc.title = name
  doc.head.innerHTML = '<meta charset="utf-8">'
  const style = doc.createElement('style')
  style.textContent = VIEWER_STYLE
  doc.head.append(style)
  doc.body.replaceChildren()
  const header = doc.createElement('header')
  const title = doc.createElement('strong')
  title.textContent = name
  const status = doc.createElement('span')
  status.className = 'status'
  status.textContent = '正在取附件…'
  header.append(title, status)
  const main = doc.createElement('main')
  doc.body.append(header, main)

  const link = (blob: Blob, fileName: string, small = false) => {
    const anchor = doc.createElement('a')
    anchor.className = small ? 'download small' : 'download'
    anchor.href = tabUrl.createObjectURL(blob)
    anchor.download = fileName
    anchor.textContent = '下载'
    return anchor
  }
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
    const node = doc.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
  }
  return { doc, tabUrl, header, status, main, link, element }
}

type Viewer = ReturnType<typeof makeViewer>

async function showMail(viewer: Viewer, blob: Blob) {
  const { letter, files } = await unpack(new Uint8Array(await blob.arrayBuffer()))
  const box = viewer.element('div')
  box.className = 'mail'
  const facts = viewer.element('dl')
  const rows: Array<[string, string]> = [
    ['发件人', letter.from || '—'],
    ['收件人', letter.to || '—'],
    ...(letter.cc ? ([['抄送', letter.cc]] as Array<[string, string]>) : []),
    ['时间', letter.date ? new Date(letter.date).toLocaleString('zh-CN', { hour12: false }) : '—'],
    ['标题', letter.subject || '—'],
  ]
  for (const [label, value] of rows) facts.append(viewer.element('dt', label), viewer.element('dd', value))
  facts.append(viewer.element('dt', '附件'))
  const list = viewer.element('dd')
  if (!letter.attachments.length) list.textContent = '无'
  else {
    const items = viewer.element('ul')
    for (const file of letter.attachments) {
      const item = viewer.element('li', file.name)
      item.append(viewer.link(files[file.index], file.name, true))
      items.append(item)
    }
    list.append(items)
  }
  facts.append(list)
  const frame = viewer.element('iframe')
  frame.className = 'fill'
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  frame.srcdoc = letter.html
  box.append(facts, frame)
  viewer.main.append(box)
}

async function showFile(viewer: Viewer, file: MailFile, blob: Blob) {
  const sniffed = sniffType(new Uint8Array(await blob.slice(0, 16).arrayBuffer()))
  const typed =
    sniffed || (blob.type.startsWith('image/') || blob.type === 'application/pdf' ? blob.type : '')
  const shown = typed ? { ...file, type: typed } : file
  const kind = viewKindOf(shown)
  if (kind === 'pdf') {
    const frame = viewer.element('iframe')
    frame.className = 'fill'
    frame.src = viewer.tabUrl.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
    viewer.main.append(frame)
  } else if (kind === 'image') {
    const box = viewer.element('div')
    box.className = 'image'
    const image = viewer.element('img')
    image.alt = file.name
    image.src = viewer.tabUrl.createObjectURL(
      new Blob([blob], { type: IMAGE_TYPES[extensionOf(shown.name)] ?? shown.type }),
    )
    box.append(image)
    viewer.main.append(box)
  } else if (kind === 'text') {
    viewer.main.append(viewer.element('pre', await blob.text()))
  } else if (kind === 'html') {
    const frame = viewer.element('iframe')
    frame.className = 'fill'
    frame.setAttribute('sandbox', '')
    frame.srcdoc = await blob.text()
    viewer.main.append(frame)
  } else if (kind === 'mail') {
    await showMail(viewer, blob)
  } else {
    const note = viewer.element('div')
    note.className = 'note'
    const extension = extensionOf(file.name)
    note.append(
      viewer.element('p', `浏览器不能直接显示${extension ? ` .${extension} ` : '这种'}文件。`),
      viewer.element('p', '点右上角「下载」，保存后用对应的软件打开。'),
    )
    viewer.main.append(note)
  }
}

/**
 * 打开附件。tab 是点击时立刻开的空白标签页，取附件要等，等完再开会被浏览器当成弹窗拦掉。
 * 这封信已在页面里拆开就直接显示；只看过缓存时，再从邮箱取一次原文。
 */
export async function openMailAttachment(ticketId: string, file: MailFile, tab: Window | null) {
  if (!tab) throw new Error('浏览器拦住了新标签页。请在地址栏右侧允许本站弹出窗口，再点一次附件。')
  const viewer = makeViewer(tab, file.name)
  try {
    const mail =
      opened.get(ticketId) ??
      (await openFromMailbox(ticketId, (update) => {
        viewer.status.textContent = `正在取附件：${update.step} ${update.pct}%`
      }))
    const found = fileBlob(mail, file)
    if (!found) throw new Error('这封信里没有这个附件了')
    await showFile(viewer, found.shown, found.blob)
    viewer.status.remove()
    if (viewKindOf(found.shown) !== 'pdf') viewer.header.append(viewer.link(found.blob, found.shown.name))
  } catch (err) {
    viewer.status.className = 'status error'
    viewer.status.textContent = err instanceof Error ? err.message : '附件打开失败'
    throw err
  }
}

/** 点 signature 时，整封只向邮箱取一次，抽出签名图。图只留在这一页的内存里，不写入数据库。 */
export async function loadSignaturePictures(ticketId: string, messageId: string, files: MailFile[]) {
  const mail =
    opened.get(`m:${messageId}`) ??
    (await openFromMailbox(ticketId, () => undefined, undefined, messageId))
  const seen = new Set<Blob>()
  const picked: { blob: Blob; name: string }[] = []
  const take = (blob: Blob | null | undefined, name = '') => {
    if (!blob || seen.has(blob)) return
    seen.add(blob)
    picked.push({ blob, name })
  }
  for (const blob of mail.signatures) take(blob, 'signature')
  for (const file of files) take(signatureBlob(mail, file), file.name)
  for (const [name, blob] of mail.linked) {
    if (name === '图片' || pastedImageName(name)) continue
    const asked = files.some((file) => {
      const wanted = fileBase(file.name)
      const have = fileBase(name)
      return Boolean(wanted) && (wanted === have || have.includes(wanted) || wanted.includes(have))
    })
    if (!asked && !signatureAssetName(name)) continue
    take(blob, name)
  }
  for (const item of mail.letter.attachments) {
    const asked = files.some((file) => file.name.trim().toLowerCase() === item.name.trim().toLowerCase())
    if (!asked && !signatureAssetName(item.name)) continue
    take(mail.files[item.index], item.name)
  }
  const urls: string[] = []
  for (const { blob, name } of picked) {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer())
    const sniffed = sniffType(head)
    const type = (sniffed?.startsWith('image/') ? sniffed : '') || (blob.type.startsWith('image/') ? blob.type : '') || IMAGE_TYPES[extensionOf(name)] || ''
    if (!type.startsWith('image/')) continue
    urls.push(URL.createObjectURL(new Blob([blob], { type })))
  }
  return urls
}

function signatureBlob(mail: OpenedMail, file: MailFile) {
  const found = fileBlob(mail, file)
  if (found) return found.blob
  const mark = file.name.match(/image\d{1,3}\.(?:png|jpe?g|gif)/i)?.[0]?.toLowerCase()
  if (!mark) return null
  for (const [name, blob] of mail.linked) {
    if (name.toLowerCase().includes(mark)) return blob
  }
  for (const item of mail.letter.attachments) {
    if (!item.name.toLowerCase().includes(mark)) continue
    const blob = mail.files[item.index]
    if (blob) return blob
  }
  return null
}

/** 打开任务里某一封信的附件。按文件名对上这次从原信拆出的附件，仍走原来的打开方式。 */
export async function openMessageAttachment(ticketId: string, messageId: string, file: MailFile, tab: Window | null) {
  if (!tab) throw new Error('浏览器拦住了新标签页。请在地址栏右侧允许本站弹出窗口，再点一次附件。')
  const viewer = makeViewer(tab, file.name)
  try {
    const mail =
      opened.get(`m:${messageId}`) ??
      (await openFromMailbox(
        ticketId,
        (update) => {
          viewer.status.textContent = `正在取附件：${update.step} ${update.pct}%`
        },
        undefined,
        messageId,
      ))
    const found = fileBlob(mail, file)
    if (!found) throw new Error('这封信里没有这个附件了')
    await showFile(viewer, found.shown, found.blob)
    viewer.status.remove()
    if (viewKindOf(found.shown) !== 'pdf') viewer.header.append(viewer.link(found.blob, found.shown.name))
  } catch (err) {
    viewer.status.className = 'status error'
    viewer.status.textContent = err instanceof Error ? err.message : '附件打开失败'
    throw err
  }
}
