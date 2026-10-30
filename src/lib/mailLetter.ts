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
}

type Progress = (update: MailReadProgress) => void

/** 拆信规则变了就加一。缓存里旧规则拆出的信会重新从邮箱取，附件序号才对得上。 */
const LETTER_FORMAT = 3

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

function toDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

const BLOCKED_TAGS = 'script, iframe, frame, frameset, object, embed, applet, form, link, base, meta[http-equiv]'
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'background'])

/** 原信 HTML 只保留版式和内容：去掉脚本、外链、事件；内嵌图换成本地数据；链接在新标签页打开。 */
function cleanHtml(raw: string, inline: Map<string, string>) {
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
    if (!/^cid:/i.test(src)) return
    const data = inline.get(cidOf(src))
    if (data) image.setAttribute('src', data)
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
  const referenced = new Set(Array.from(html.matchAll(/cid:([^"'\s)>]+)/gi), (match) => cidOf(match[1])))
  const inline = new Map<string, string>()
  const files: Blob[] = []
  const attachments: MailFile[] = []

  for (const part of email.attachments) {
    const type = part.mimeType || 'application/octet-stream'
    const blob = new Blob([part.content as BlobPart], { type })
    const cid = part.contentId ? cidOf(part.contentId) : ''
    if (cid && referenced.has(cid) && type.startsWith('image/')) {
      inline.set(cid, await toDataUrl(blob))
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
    ? cleanHtml(html, inline)
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
  }
}

/** 从邮箱取出整封原文并拆开。不看缓存。 */
async function openFromMailbox(ticketId: string, onProgress: Progress, signal?: AbortSignal) {
  const response = await callMailRead({ ticketId, fresh: true }, signal)
  const reply = await readFrames(response, onProgress)
  if (!reply.source) throw new Error('这张工单没有对应的邮件')
  const mail = await unpack(reply.source)
  remember(ticketId, mail)
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
  const kind = viewKindOf(file)
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
      new Blob([blob], { type: IMAGE_TYPES[extensionOf(file.name)] ?? file.type }),
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
    const blob = mail.files[file.index]
    if (!blob) throw new Error('这封信里没有这个附件了')
    await showFile(viewer, file, blob)
    viewer.status.remove()
    if (viewKindOf(file) !== 'pdf') viewer.header.append(viewer.link(blob, file.name))
  } catch (err) {
    viewer.status.className = 'status error'
    viewer.status.textContent = err instanceof Error ? err.message : '附件打开失败'
    throw err
  }
}
