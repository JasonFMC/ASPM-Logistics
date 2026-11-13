import { useEffect, useRef, useState } from 'react'
import { MailFileIcon } from './MailFileIcon'
import { isInlineBodyImage, isSignatureFile, isTrailingSignatureImage, loadMessageFlow, loadSignaturePictures, type MailFile } from '../lib/mailLetter'
import type { TicketMessage } from '../lib/messages'

function formatWhen(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${month}月${day}日 ${hours}:${minutes}`
}

function EmbeddedImageIcon() {
  return (
    <svg className="mail-signature-icon" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="10" r="1.3" fill="currentColor" />
      <path d="M4 16.5l4.2-3.6 2.8 2.4 2.4-2.1L20 16.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function SignatureMark() {
  return (
    <svg className="mail-signature-mark" viewBox="0 0 148 40" aria-hidden="true">
      <text x="2" y="30" fill="currentColor" fontFamily="Segoe Script, 'Brush Script MT', cursive" fontSize="32">
        signature
      </text>
    </svg>
  )
}

function hideImageMarks(text: string) {
  return text
    .replace(/\[image:\s*[^\]]+\]/gi, '')
    .replace(/\[[^\]\n]*?(?:cid:)?[^\]\n]*?image\d+\.(?:png|jpe?g|gif)@[^\]\n]*\]/gi, '')
    .replace(/\[cid:[^\]\n]*\]/gi, '')
    .replace(/<image\d+\.(?:png|jpe?g|gif)>/gi, '')
    .replace(/^[^\n]*image\d+\.(?:png|jpe?g|gif)@[^\n]*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

type LaidPiece = { text: string } | { file: MailFile }

function fileForMark(mark: string, files: MailFile[]) {
  const lower = mark.toLowerCase()
  const named = lower.match(/image\d+\.(?:png|jpe?g|gif)/)?.[0] ?? lower.replace(/^\[image:\s*/i, '').replace(/\]$/, '').trim()
  return files.find((file) => {
    const base = file.name.trim().toLowerCase()
    const stem = base.replace(/\.[^.]+$/, '')
    return Boolean(named) && (base.includes(named) || named.includes(base) || (stem.length > 2 && lower.includes(stem)))
  })
}

function isPicture(file: MailFile) {
  return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)
}

/** 正文里的图留在原信的那一段。 */
function layOut(text: string, images: MailFile[], used: Set<MailFile>) {
  const pieces: LaidPiece[] = []
  const pattern =
    /\[image:\s*([^\]]+)\]|\[[^\]\n]*?(?:cid:)?[^\]\n]*?image\d+\.(?:png|jpe?g|gif)@[^\]\n]*\]|<image\d+\.(?:png|jpe?g|gif)>|^[^\n]*?image\d+\.(?:png|jpe?g|gif)@[^\n]*$/gim
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) pieces.push({ text: text.slice(last, index) })
    const file = fileForMark(match[0], images)
    if (file) {
      used.add(file)
      pieces.push({ file })
    }
    last = index + match[0].length
  }
  if (last < text.length) pieces.push({ text: text.slice(last) })
  return pieces
}

function InlineImage({
  messageId,
  file,
  openingFile,
  onOpen,
}: {
  messageId: string
  file: MailFile
  openingFile: string | null
  onOpen: (messageId: string, file: MailFile) => void
}) {
  const key = `${messageId}:${file.index}`
  return (
    <button
      type="button"
      className="mail-signature-link"
      aria-label="内嵌图片"
      disabled={openingFile === key}
      onClick={() => onOpen(messageId, file)}
    >
      <EmbeddedImageIcon />
    </button>
  )
}

/** 信还停在 quoted-printable 时，先还原成文字。=20 是空格，=E2=80=99 是撇号，行尾的 = 是折行。 */
function decodeQuotedPrintable(value: string) {
  if (!value) return ''
  const marks = value.match(/=[0-9A-Fa-f]{2}/g)
  if (!/=\r?\n/.test(value) && (marks?.length ?? 0) < 3) return value.replace(/[\u200b\u200c\u200d\ufeff]/g, '')
  const unfolded = value.replace(/=\r?\n/g, '')
  const decodeBytes = (bytes: number[]) => new TextDecoder('utf-8').decode(Uint8Array.from(bytes))
  const tidy = (text: string) =>
    text
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/^[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
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

function plainSign(line: string) {
  return line.trim().replace(/\*/g, '').replace(/\s+/g, ' ').trim()
}

function signSignal(line: string) {
  const text = plainSign(line)
  if (!text) return false
  if (/https?:\/\/|^www\./i.test(text)) return true
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text)) return true
  if (/(?:\+?\d[\d\s().*/-]{6,}\d)/.test(text)) return true
  return /\b(?:pty\.?\s*ltd|p\/l|ltd|inc|group|warehouse|logistics|loading\s*time|site\s*contact|mob(?:ile|ie)?|unit\s*\d|level\s*\d|road|street|\bst\.?\b|avenue|plaza|nsw|vic|qld|sydney|3pl)\b/i.test(text)
}

function isSignPiece(line: string) {
  const text = plainSign(line)
  if (!text) return false
  if (/\b(?:will|please|kindly|pls|arrange|deliver|send|need|confirm|ready|tomorrow|today|attached)\b/i.test(text)) return false
  if (text.split(' ').length > 16 && !/mailto:|https?:|standard trading|confidential/i.test(text)) return false
  if (signSignal(line)) return true
  if (/mailto:|<https?:|https?:\/\//i.test(text)) return true
  if (/^(?:t|tel|mob|mobile|email|e-mail|web|website|fax|ph|phone)\s*[:：]/i.test(text)) return true
  if (/\bpo\s*box\b/i.test(text)) return true
  if (/standard trading|confidential|disclaimer|privileged/i.test(text)) return true
  const spaces = text.split(' ').length - 1
  return text.length > 12 && spaces <= 2 && /[/?=&+]/.test(text)
}

function isSignTail(line: string, previous = '') {
  const text = plainSign(line)
  if (!text) return false
  if (/^\(/.test(text) || /upon request|standard trading|confidential|disclaimer|liability|\bexempt\b/i.test(text)) return true
  if (/^(?:thanks|thank you|regards|cheers|sincerely)\b/i.test(text)) return true
  const spaces = text.split(' ').length - 1
  if (text.length > 8 && spaces <= 2 && /[/?=&+>]/.test(text)) return true
  const prior = plainSign(previous)
  return /standard trading|upon request|liability|\bexempt\b/i.test(prior) && !/^(?:please|kindly|pls|hi|hello|dear|arrange|deliver|ship)\b/i.test(text)
}

function personName(line: string) {
  const text = plainSign(line)
  if (!text || text.length > 40 || /\d|@|https?:|[/:：|]/.test(text)) return ''
  if (/\b(?:pty|ltd|inc|group|warehouse|logistics|road|street|avenue|plaza|nsw|vic|qld|sydney|unit|level|box)\b/i.test(text)) return ''
  if (/^(?:hi|hello|dear|thanks|thank you|regards|cheers|sincerely|please|kindly|best)\b/i.test(text)) return ''
  const words = text.split(' ')
  const latin = words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Za-z][A-Za-z'.’-]*$/.test(word))
  const single = words.length === 1 && /^[A-Z][a-z]{1,19}$/.test(text) && !/^(?:team|support|power|official|partner|best|kind|regards|thanks|please|send|here|from|sent|email|phone)$/i.test(text)
  const cjk = /^[\u4e00-\u9fff]{2,4}$/.test(text)
  return latin || single || cjk ? text : ''
}

function lastClosing(lines: string[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = plainSign(lines[index]).replace(/[,，.。]+$/g, '')
    if (/^(?:thanks|thank you|kind regards|best regards|warm regards|regards|cheers|sincerely)$/i.test(text)) return index
  }
  return -1
}

function isJobTitle(line: string) {
  return /\b(?:manager|director|coordinator|officer|supervisor|specialist|consultant|executive|assistant|representative)\b/i.test(plainSign(line))
}

function takeSigner(message: string) {
  const lines = message.split('\n')
  let end = lines.length - 1
  while (end >= 0 && !lines[end].trim()) end -= 1
  if (end < 0) return { message, name: '' }
  let cursor = end
  if (isJobTitle(lines[cursor])) {
    cursor -= 1
    while (cursor >= 0 && !lines[cursor].trim()) cursor -= 1
  }
  const name = cursor >= 0 ? personName(lines[cursor]) : ''
  if (!name && !isJobTitle(lines[end])) return { message, name: '' }
  const from = name ? cursor : end
  lines.splice(from, end - from + 1)
  return { message: lines.join('\n').trim(), name }
}

/** 末尾的地址、链接、免责声明整段拿开。只留下签名里的姓名。 */
function splitSignoff(body: string) {
  const lines = body.split('\n')
  const closing = lastClosing(lines)
  if (closing >= 0) {
    const after = lines.slice(closing + 1)
    const name = after.map((line) => personName(line)).find((line) => line)
    const contactAfter = after.some((line) => signSignal(line) || /\b(?:pty|ltd|team|partner)\b/i.test(plainSign(line)))
    if (name && contactAfter) {
      return { message: lines.slice(0, closing).join('\n').trim(), name, signed: true, tail: lines.slice(closing).join('\n').trim() }
    }
  }
  const contact = (line: string) => signSignal(line) || /mailto:|https?:|@|\bpo\s*box\b|\bpty\b|\bltd\b/i.test(plainSign(line))
  let last = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() && contact(lines[index])) {
      last = index
      break
    }
  }
  if (last < 0) return { message: body.trim(), name: '', signed: false, tail: '' }
  let previous = lines[last] ?? ''
  for (let index = last + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    if (!isSignPiece(line) && !isSignTail(line, previous)) return { message: body.trim(), name: '', signed: false, tail: '' }
    previous = line
  }
  let start = last
  for (let index = last - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line) continue
    if (isSignPiece(line)) {
      start = index
      continue
    }
    break
  }
  const above = [...lines.slice(0, start)].reverse().find((line) => line.trim()) ?? ''
  if (/^(?:ship(?:\s+to)?|deliver(?:y)?(?:\s+(?:address|to))?|consignee|send\s+to|attn|address)\b/i.test(plainSign(above)) && plainSign(above).length < 48) {
    return { message: body.trim(), name: '', signed: false, tail: '' }
  }
  const signoff = tidySign(lines.slice(start).join('\n'))
  const block = lines.slice(start).filter((line) => line.trim())
  const pieces = block.filter((line) => isSignPiece(line))
  if (!signoff || pieces.length < 1) return { message: body.trim(), name: '', signed: false, tail: '' }
  const message = lines.slice(0, start).join('\n').trim()
  const peeled = takeSigner(message)
  return {
    message: peeled.message,
    name: peeled.name || signerFromBlock(lines.slice(start)),
    signed: true,
    tail: lines.slice(start).join('\n').trim(),
  }
}

function signerFromBlock(blockLines: string[]) {
  let seen = 0
  for (const line of blockLines) {
    const text = plainSign(line)
    if (!text) continue
    seen += 1
    if (seen > 4) break
    const head = text.split(/\s+[-–—|]\s+/)[0] ?? ''
    const name = personName(head)
    if (name) return name
  }
  return ''
}

function tidySign(text: string) {
  return text
    .split('\n')
    .map((line) => line.replace(/\*/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function onWroteSpan(lines: string[], index: number) {
  let joined = ''
  for (let cursor = index; cursor < Math.min(lines.length, index + 3); cursor += 1) {
    joined = `${joined} ${lines[cursor].trim()}`.trim()
    if (/^On\s+.{10,}wrote:\s*$/i.test(joined) && /@|\d/.test(joined)) return cursor + 1
  }
  return null
}

function replyMarkerName(line: string) {
  const match = line.trim().match(/^([^<>:\n]{1,60}?)\s<[^<>\s@]+@[^<>\s>]+>$/)
  const name = match?.[1]?.replace(/^["']|["']$/g, '').trim() ?? ''
  if (!name || /^(?:from|sent|to|cc|subject)$/i.test(name)) return ''
  return name
}

function isQuoteStart(lines: string[], index: number) {
  const line = lines[index]?.trim() ?? ''
  if (!line) return false
  if (replyMarkerName(line)) return true
  if (/^>+/.test(line)) return true
  if (/^-{2,}\s*(?:原始邮件|Original Message)\s*-{2,}$/i.test(line)) return true
  if (/^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line)) return true
  if (/^On .+ wrote:\s*$/i.test(line) || /^在.+写道[:：]?\s*$/.test(line)) return true
  if (onWroteSpan(lines, index) !== null) return true
  if (/^发件人[:：]\s*\S/.test(line)) return true
  if (/^_{5,}$/.test(line)) return lines.slice(index + 1, index + 4).some((item) => /^(?:From|发件人)\s*[:：]\s*\S/i.test(item.trim()))
  if (/^From:\s+\S/i.test(line)) {
    const window = lines.slice(index, index + 8).join('\n')
    return /^(?:Sent|Date|To|Cc|Subject|发送时间|日期|收件人|抄送|主题)\s*[:：]/im.test(window)
  }
  return false
}

function quoteEnd(lines: string[], index: number) {
  const wrote = onWroteSpan(lines, index)
  if (wrote !== null && /^>+/.test(lines[wrote]?.trim() ?? '')) {
    let cursor = wrote
    while (cursor < lines.length && (!lines[cursor].trim() || /^>+/.test(lines[cursor].trim()))) cursor += 1
    return cursor
  }
  if (/^>+/.test(lines[index].trim())) {
    let cursor = index + 1
    while (cursor < lines.length && (!lines[cursor].trim() || /^>+/.test(lines[cursor].trim()))) cursor += 1
    return cursor
  }
  for (let cursor = wrote ?? index + 1; cursor < lines.length; cursor += 1) {
    if (isQuoteStart(lines, cursor)) return cursor
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
  const marked = replyMarkerName(lines[index] ?? '')
  if (marked) return marked.slice(0, 160)
  for (const raw of lines.slice(index, Math.min(end, index + 8))) {
    const from = raw.trim().replace(/^>+\s?/, '').match(/^(?:From|发件人)\s*[:：]\s*(.+)$/i)
    if (from) return from[1].trim().slice(0, 160)
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
      /^Forwarded message$/i.test(text) ||
      replyMarkerName(text)
    ) {
      start += 1
      continue
    }
    break
  }
  return block
    .slice(start)
    .map((line) => line.replace(/^>+\s?/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface LetterQuote {
  heading: string
  body: string
}

function unpackLetter(body: string) {
  const parts = body.split('\u001e')
  const fresh = (parts[0] ?? '').trim()
  const quotes: LetterQuote[] = parts.slice(1).map((part) => {
    const text = part.replace(/^\n/, '')
    const breakAt = text.indexOf('\n')
    const heading = (breakAt < 0 ? text : text.slice(0, breakAt)).trim()
    const quoteBody = (breakAt < 0 ? '' : text.slice(breakAt + 1)).trim()
    return { heading, body: quoteBody }
  }).filter((quote) => quote.body)
  return { fresh, quotes }
}

function liftQuotes(fresh: string, quotes: LetterQuote[]) {
  const lines = fresh.split('\n')
  const kept: string[] = []
  const found = [...quotes]
  let index = 0
  while (index < lines.length) {
    if (!isQuoteStart(lines, index)) {
      kept.push(lines[index])
      index += 1
      continue
    }
    const end = Math.max(quoteEnd(lines, index), index + 1)
    const body = stripQuoteHeaders(lines.slice(index, end))
    if (body) found.push({ heading: quoteHeading(lines, index, end), body })
    index = end
  }
  return { fresh: kept.join('\n').trim(), quotes: found }
}

function splitQuoted(text: string) {
  const unpacked = unpackLetter(text)
  const lifted = liftQuotes(unpacked.fresh, [])
  const pending = [...unpacked.quotes, ...lifted.quotes]
  const quotes: LetterQuote[] = []
  while (pending.length > 0) {
    const quote = pending.shift()
    if (!quote) break
    const inner = liftQuotes(quote.body, [])
    if (inner.quotes.length === 0) {
      quotes.push(quote)
      continue
    }
    if (inner.fresh) quotes.push({ heading: quote.heading, body: inner.fresh })
    pending.unshift(...inner.quotes)
  }
  return { fresh: lifted.fresh, quotes: quotes.filter((quote) => quote.body) }
}

function normalizeWriting(text: string) {
  return text
    .replace(/\[image:[^\]]*\]/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/<mailto:[^>]*>/gi, ' ')
    .replace(/mailto:\S+/gi, ' ')
    .replace(/<https?:\/\/[^>]*>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, ' ')
    .replace(/&(?:amp|nbsp);/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 这封信自己新写的话。用来和后面的信比较，不看抬头。 */
function letterWriting(body: string) {
  const fresh = splitQuoted(decodeQuotedPrintable(body)).fresh
  return hideImageMarks(splitSignoff(fresh).message)
}

/** 紧挨着重复正文的抬头行。不是用来判断引用，只在已经对上正文之后拿掉。 */
function isQuoteFurniture(line: string) {
  const text = line.trim()
  if (!text) return true
  if (/mailto:/i.test(text)) return true
  const stripped = text
    .replace(/<mailto:[^>]*>/gi, '')
    .replace(/mailto:\S+/gi, '')
    .replace(/<https?:\/\/[^>]*>/gi, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '')
    .replace(/[<>]/g, '')
    .trim()
  if (!stripped) return true
  return /^[A-Za-z]{2,14}:\s+\S/.test(text)
}

/**
 * 拿这封信的正文，和这张工单里更早的信直接比较。
 * 对上的那一段收成一次「引用了上一封」，不先猜抬头写成什么样。
 */
function collapseRepeated(text: string, writings: string[]) {
  const matched = writings.map(() => false)
  const prepared = writings.map((item, index) => ({ index, words: normalizeWriting(item) })).filter((item) => item.words.length >= 40)
  if (!text.trim() || prepared.length === 0) return { text, seen: 0, matched }

  const lines = text.split('\n')
  let norm = ''
  const at: number[] = []
  lines.forEach((line, index) => {
    const key = normalizeWriting(line)
    if (!key) return
    const piece = `${norm ? ' ' : ''}${key}`
    for (let cursor = 0; cursor < piece.length; cursor += 1) at.push(index)
    norm += piece
  })

  const hits: { start: number; end: number }[] = []
  for (const item of prepared) {
    const probe = item.words.slice(0, Math.min(80, item.words.length))
    const found = norm.indexOf(probe)
    if (found < 0 || probe.length < 40) continue
    let length = probe.length
    while (length < item.words.length && norm[found + length] === item.words[length]) length += 1
    const start = at[found]
    const end = at[found + length - 1]
    if (start === undefined || end === undefined) continue
    matched[item.index] = true
    hits.push({ start, end })
  }
  if (hits.length === 0) return { text, seen: 0, matched }

  hits.sort((a, b) => a.start - b.start)
  const drop = new Array<boolean>(lines.length).fill(false)
  hits.forEach((hit, hitIndex) => {
    for (let index = hit.start; index <= hit.end; index += 1) drop[index] = true
    for (let index = hit.start - 1; index >= 0; index -= 1) {
      if (drop[index] || isQuoteFurniture(lines[index] ?? '')) {
        drop[index] = true
        continue
      }
      break
    }
    const nextStart = hits[hitIndex + 1]?.start ?? lines.length
    for (let index = hit.end + 1; index < nextStart; index += 1) {
      const line = lines[index] ?? ''
      if (isQuoteFurniture(line) || isSignPiece(line) || personName(line)) {
        drop[index] = true
        continue
      }
      break
    }
  })
  const first = drop.findIndex(Boolean)
  const last = drop.lastIndexOf(true)
  for (let index = first; index <= last; index += 1) {
    if (isQuoteFurniture(lines[index] ?? '')) drop[index] = true
  }

  return {
    text: lines.filter((_, index) => !drop[index]).join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    seen: hits.length,
    matched,
  }
}

/** 拆出来的引用里，仍能对上更早那封信的正文。一封算一次。 */
function quoteMatches(quote: string, others: string[]) {
  const needle = normalizeWriting(quote)
  if (needle.length < 40) return 0
  return others.filter((other) => {
    const hay = normalizeWriting(other)
    if (hay.length < 40) return false
    const probe = hay.slice(0, Math.min(80, hay.length))
    return needle.includes(hay) || hay.includes(needle) || needle.includes(probe)
  }).length
}

function formatSize(bytes: number) {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function TicketThread({
  ticketId,
  messages,
  openingMail,
  openingFile,
  fallbackFiles = [],
  onOpenMail,
  onOpenFile,
}: {
  ticketId: string
  messages: TicketMessage[]
  openingMail: string | null
  openingFile: string | null
  /** 第一条还没记下附件名字时，用打开原信拆出来的列表。 */
  fallbackFiles?: MailFile[]
  onOpenMail: (messageId: string) => void
  onOpenFile: (messageId: string, file: MailFile) => void
}) {
  const [pictures, setPictures] = useState<Record<string, string[]>>({})
  const [pictureState, setPictureState] = useState<Record<string, 'loading' | 'error'>>({})
  const [pictureError, setPictureError] = useState<Record<string, string>>({})
  const [openSlot, setOpenSlot] = useState<Record<string, boolean>>({})
  const picturesRef = useRef(pictures)
  picturesRef.current = pictures
  const [flows, setFlows] = useState<Record<string, { text: string; signatureNames: string[] }>>({})
  const flowKey = messages.map((item) => `${item.id}:${item.attachments.length}`).join('|')
  useEffect(() => {
    let cancel = false
    const pending = messages.filter((item) => item.attachments.length > 0)
    void (async () => {
      for (const item of pending) {
        if (cancel) return
        try {
          const flow = await loadMessageFlow(ticketId, item.id)
          if (!cancel) setFlows((current) => ({ ...current, [item.id]: flow }))
        } catch {
          if (!cancel) setFlows((current) => ({ ...current, [item.id]: { text: '', signatureNames: [] } }))
        }
      }
    })()
    return () => {
      cancel = true
    }
  }, [ticketId, flowKey])
  useEffect(() => {
    return () => {
      for (const urls of Object.values(picturesRef.current)) {
        for (const url of urls) URL.revokeObjectURL(url)
      }
    }
  }, [])

  function openSignature(messageId: string, slot: string, files: MailFile[]) {
    if (openSlot[slot]) {
      setOpenSlot((current) => ({ ...current, [slot]: false }))
      return
    }
    setOpenSlot((current) => ({ ...current, [slot]: true }))
    if (pictures[messageId] || pictureState[messageId] === 'loading') return
    setPictureState((current) => ({ ...current, [messageId]: 'loading' }))
    setPictureError((current) => ({ ...current, [messageId]: '' }))
    void loadSignaturePictures(ticketId, messageId, files)
      .then((urls) => {
        setPictures((current) => ({ ...current, [messageId]: urls }))
        setPictureState((current) => {
          const next = { ...current }
          delete next[messageId]
          return next
        })
      })
      .catch((err: unknown) => {
        setPictureState((current) => ({ ...current, [messageId]: 'error' }))
        setPictureError((current) => ({
          ...current,
          [messageId]: err instanceof Error ? err.message : '签名没有取到',
        }))
      })
  }

  return (
    <section className="mail-thread" aria-label="来往邮件">
      <div className="mail-thread-head">
        <span>{messages.length} 封信</span>
        <span>新写的内容，以及对不上的引用</span>
      </div>
      <ol>
        {messages.map((message, index) => {
          const files = message.attachments.length > 0 ? message.attachments : index === 0 ? fallbackFiles : []
          const bodyText = decodeQuotedPrintable(message.body ?? '')
          const flow = flows[message.id]
          const plain = flow?.text || bodyText
          const signatureNames = new Set((flow?.signatureNames ?? []).map((name) => name.toLowerCase()))
          const signatures = flow
            ? files.filter((file) => signatureNames.has(file.name.trim().toLowerCase()))
            : files.filter((file) => isSignatureFile(file) || isTrailingSignatureImage(file, bodyText))
          const pasted = files.filter((file) => !signatures.includes(file) && isInlineBodyImage(file, plain))
          const attached = files.filter((file) => {
            if (signatures.includes(file) || pasted.includes(file)) return false
            if (!flow && isPicture(file)) return false
            return true
          })
          const earlierWritings = messages.slice(0, index).map((item) => letterWriting(item.body ?? ''))
          const collapsed = collapseRepeated(plain, earlierWritings)
          const letter = splitQuoted(collapsed.text)
          const own = splitSignoff(letter.fresh)
          const quotes = letter.quotes
            .map((quote) => {
              const peeled = splitSignoff(quote.body)
              return { heading: quote.heading, body: peeled.message, name: peeled.name, signed: peeled.signed, tail: peeled.tail }
            })
            .filter((quote) => quote.body || quote.name)
          const quoted = quotes.map((quote) => ({
            quote,
            seen: quoteMatches(
              hideImageMarks(quote.body),
              earlierWritings.filter((_, writingIndex) => !collapsed.matched[writingIndex]),
            ),
          }))
          const freshQuotes = quoted.filter((item) => !item.seen)
          const seenQuotes = quoted.filter((item) => item.seen)
          const placed = new Set<MailFile>()
          const ownPieces = layOut(own.message, pasted, placed)
          const quotePieces = freshQuotes.map(({ quote }) => ({ quote, pieces: layOut(quote.body, pasted, placed) }))
          const filesAtStart = attached
          return (
          <li key={message.id} className="mail-bubble">
            <header>
              <span className="mail-sender">{message.from_name || message.from_email || '发件人'}</span>
              <time dateTime={message.received_at ?? undefined}>{formatWhen(message.received_at)}</time>
            </header>
            {filesAtStart.length > 0 && (
              <ul className="mail-files">
                {filesAtStart.map((file) => {
                  const key = `${message.id}:${file.index}`
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        className="mail-file"
                        title={`打开 ${file.name}`}
                        disabled={openingFile === key}
                        onClick={() => onOpenFile(message.id, file)}
                      >
                        <MailFileIcon name={file.name} type={file.type} />
                        <span className="mail-file-text">
                          <span className="mail-file-name">{file.name}</span>
                          <span className="mail-file-size">{openingFile === key ? '打开中…' : formatSize(file.size)}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <p>
              {ownPieces.some((piece) => ('text' in piece ? piece.text.trim() : true))
                ? ownPieces.map((piece, pieceIndex) =>
                    'file' in piece ? (
                      <InlineImage
                        key={`${message.id}:img:${piece.file.index}:${pieceIndex}`}
                        messageId={message.id}
                        file={piece.file}
                        openingFile={openingFile}
                        onOpen={onOpenFile}
                      />
                    ) : (
                      <span key={`${message.id}:text:${pieceIndex}`}>{piece.text}</span>
                    ),
                  )
                : quotes.length || own.name
                  ? ''
                  : '这封没有新写的内容。'}
            </p>
            {(own.signed || own.name || signatures.length > 0) && (
              <div className="mail-signoff-block">
                <p className="mail-signoff">
                  {own.name && <span className="mail-sign-name">{own.name}</span>}
                  <button
                    type="button"
                    className="mail-signature-link"
                    aria-label="signature"
                    disabled={pictureState[message.id] === 'loading'}
                    onClick={() => openSignature(message.id, message.id, signatures)}
                  >
                    <SignatureMark />
                  </button>
                </p>
                {openSlot[message.id] && own.tail && <p className="mail-signoff-tail">{own.tail}</p>}
                {openSlot[message.id] && pictureError[message.id] && !own.tail && <p className="mail-signoff-error">{pictureError[message.id]}</p>}
                {openSlot[message.id] && pictures[message.id] && pictures[message.id].length > 0 && (
                  <div className="mail-signoff-images">
                    {pictures[message.id].map((url) => (
                      <img key={url} src={url} alt="signature" />
                    ))}
                  </div>
                )}
              </div>
            )}
            {Array.from({ length: collapsed.seen }, (_, copy) => (
              <p key={`${message.id}:repeat:${copy}`} className="mail-quote-seen">引用了上一封</p>
            ))}
            {seenQuotes.map(({ quote, seen }) => (
              Array.from({ length: seen }, (_, copy) => (
                <p key={`${message.id}:seen:${quote.heading}:${copy}`} className="mail-quote-seen">引用了上一封</p>
              ))
            ))}
            {freshQuotes.length > 0 && (
              <div className="mail-quote-box">
                {quotePieces.map(({ quote, pieces }) => (
                  <blockquote key={`${message.id}:${quote.heading}:${quote.body.slice(0, 24)}`} className="mail-quote">
                    {quote.heading && <span className="mail-quote-from">{quote.heading}</span>}
                    {pieces.some((piece) => ('text' in piece ? piece.text.trim() : true)) && (
                      <p>
                        {pieces.map((piece, pieceIndex) =>
                          'file' in piece ? (
                            <InlineImage
                              key={`${message.id}:quote:${piece.file.index}:${pieceIndex}`}
                              messageId={message.id}
                              file={piece.file}
                              openingFile={openingFile}
                              onOpen={onOpenFile}
                            />
                          ) : (
                            <span key={`${message.id}:quote-text:${pieceIndex}`}>{piece.text}</span>
                          ),
                        )}
                      </p>
                    )}
                    {(quote.signed || quote.name) && (
                      <div className="mail-signoff-block">
                        <p className="mail-signoff">
                          {quote.name && <span className="mail-sign-name">{quote.name}</span>}
                          <button
                            type="button"
                            className="mail-signature-link"
                            aria-label="signature"
                            disabled={pictureState[message.id] === 'loading'}
                            onClick={() => openSignature(message.id, `${message.id}:${quote.heading}`, signatures)}
                          >
                            <SignatureMark />
                          </button>
                        </p>
                        {openSlot[`${message.id}:${quote.heading}`] && quote.tail && <p className="mail-signoff-tail">{quote.tail}</p>}
                        {openSlot[`${message.id}:${quote.heading}`] && pictureError[message.id] && !quote.tail && (
                          <p className="mail-signoff-error">{pictureError[message.id]}</p>
                        )}
                        {openSlot[`${message.id}:${quote.heading}`] && pictures[message.id] && pictures[message.id].length > 0 && (
                          <div className="mail-signoff-images">
                            {pictures[message.id].map((url) => (
                              <img key={url} src={url} alt="signature" />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </blockquote>
                ))}
              </div>
            )}
            <p className="ticket-note">
              <button
                type="button"
                className="btn small"
                disabled={openingMail === message.id}
                onClick={() => onOpenMail(message.id)}
              >
                {openingMail === message.id ? '正在交给 Outlook…' : '打开原邮件'}
              </button>
            </p>
          </li>
          )
        })}
      </ol>
    </section>
  )
}
