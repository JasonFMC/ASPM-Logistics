import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { DeskGate } from '../components/DeskGate'
import { TicketStepBar } from '../components/TicketStepBar'
import { TicketTitle } from '../components/TicketTitle'
import { useFolders } from '../context/FolderContext'
import { useStaff } from '../context/StaffContext'
import { searchTickets } from '../lib/tickets'
import type { Ticket } from '../lib/types'

const EMPTY = { folderId: '', sender: '', title: '', keyword: '', from: '', to: '' }

function formatWhen(value: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function TicketSearchPage() {
  const { desk, ready } = useStaff()
  const { folders, memberships } = useFolders()
  const [draft, setDraft] = useState(EMPTY)
  const [results, setResults] = useState<Ticket[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const filled = Object.values(draft).some((value) => value.trim())
    if (!filled) {
      setError('至少填一项')
      setResults(null)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const folderIds = draft.folderId
        ? memberships.filter((item) => item.folder_id === draft.folderId).map((item) => item.ticket_id)
        : null
      setResults(
        await searchTickets({
          folderIds,
          sender: draft.sender,
          title: draft.title,
          keyword: draft.keyword,
          from: draft.from,
          to: draft.to,
        }),
      )
    } catch (err: unknown) {
      setResults(null)
      setError(err instanceof Error ? err.message : '没有搜到')
    } finally {
      setBusy(false)
    }
  }

  if (!ready || !desk) {
    return (
      <div className="buddy-page">
        {ready ? <DeskGate /> : <p className="lede">在准备领取人…</p>}
      </div>
    )
  }

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <div className="ticket-head">
        <h1>搜索任务</h1>
      </div>
      <form className="stack-form ticket-search" onSubmit={(event) => void onSubmit(event)}>
        <label>
          文档或客户
          <select value={draft.folderId} onChange={(event) => setDraft((row) => ({ ...row, folderId: event.target.value }))}>
            <option value="">不限</option>
            <optgroup label="文档整理">
              {folders
                .filter((folder) => folder.kind === 'document')
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="客户名称">
              {folders
                .filter((folder) => folder.kind === 'customer')
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.name}
                  </option>
                ))}
            </optgroup>
          </select>
        </label>
        <label>
          发件人
          <input
            value={draft.sender}
            placeholder="名字或邮箱"
            onChange={(event) => setDraft((row) => ({ ...row, sender: event.target.value }))}
          />
        </label>
        <div className="ticket-search-dates">
          <label>
            开始日期
            <input type="date" value={draft.from} onChange={(event) => setDraft((row) => ({ ...row, from: event.target.value }))} />
          </label>
          <label>
            结束日期
            <input type="date" value={draft.to} onChange={(event) => setDraft((row) => ({ ...row, to: event.target.value }))} />
          </label>
        </div>
        <label>
          标题
          <input
            value={draft.title}
            placeholder="标题里的词"
            onChange={(event) => setDraft((row) => ({ ...row, title: event.target.value }))}
          />
        </label>
        <label>
          邮件所含关键字
          <input
            value={draft.keyword}
            placeholder="多个词用空格分开，都要出现"
            onChange={(event) => setDraft((row) => ({ ...row, keyword: event.target.value }))}
          />
        </label>
        <p className="folder-note">关键字会在标题、摘要，以及两周内还留着的原信正文里找。</p>
        <button type="submit" className="btn small" disabled={busy}>
          {busy ? '搜索中…' : '搜索'}
        </button>
      </form>
      {error && <p className="page-status error">{error}</p>}
      {results && <p className="lede">找到 {results.length} 张。</p>}
      {results && results.length > 0 && (
        <ul className="ticket-list">
          {results.map((ticket) => (
            <li key={ticket.id}>
              <Link className="ticket-card" to={`/tickets/${ticket.id}`}>
                <div className="ticket-card-top">
                  {(ticket.from_name || ticket.from_email) && (
                    <span className="ticket-card-sender">{ticket.from_name || ticket.from_email}</span>
                  )}
                  <strong>
                    <TicketTitle
                      ticketId={ticket.id}
                      title={ticket.title}
                      done={ticket.status === 'done'}
                      colleagues={ticket.assignee ? [ticket.assignee.display_name] : []}
                    />
                  </strong>
                </div>
                <TicketStepBar status={ticket.status} claimedBy={ticket.claimed_by} waitingReason={ticket.waiting_reason} />
                <p className="pond-meta">
                  {ticket.received_at ? `邮件 ${formatWhen(ticket.received_at)}` : `建立 ${formatWhen(ticket.created_at)}`}
                  {ticket.status === 'done' ? ` · 完成 ${formatWhen(ticket.closed_at || ticket.updated_at)}` : ''}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
