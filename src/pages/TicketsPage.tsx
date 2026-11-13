import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { TicketThread } from '../components/TicketThread'
import { TicketTitle } from '../components/TicketTitle'
import { useFolders } from '../context/FolderContext'
import { useMailSync } from '../context/MailSyncContext'
import {
  createManualTicket,
  getTicket,
  listTicketEvents,
  listTicketNotes,
  listStageAlerts,
  listTicketStages,
  listTickets,
  listTicketsByIds,
  listWarehouses,
  listWorkflows,
  missingTicketsTable,
  ticketOpsHint,
  type TicketPool,
  TICKET_SOURCE_LABEL,
  TICKET_STATUS_LABEL,
} from '../lib/tickets'
import {
  MAIL_CACHE_STEPS,
  MAIL_STEPS,
  openMailAttachment,
  openMessageAttachment,
  openOriginalMail,
  readMailLetter,
  type MailFile,
  type MailLetter,
  type MailReadProgress,
} from '../lib/mailLetter'
import { listTicketMessages, type TicketMessage } from '../lib/messages'
import { MailFileIcon } from '../components/MailFileIcon'
import { DeskGate } from '../components/DeskGate'
import { TicketJob } from '../components/TicketJob'
import { TicketPonds } from '../components/TicketPonds'
import { TicketStepBar } from '../components/TicketStepBar'
import { useStaff } from '../context/StaffContext'
import { applyAutoClaims, missingStaffSetup, claimTicket, releaseTicket } from '../lib/staff'
import type { StageAlert, Ticket, TicketEvent, TicketNote, TicketStage, Warehouse, Workflow } from '../lib/types'

function formatWhen(value: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function senderOf(letter: MailLetter | null, ticket: Pick<Ticket, 'from_name' | 'from_email'>) {
  const raw = letter?.from?.trim() || ''
  const wrapped = raw.match(/^(.*)<([^>]+)>$/)
  const name = (wrapped ? wrapped[1].trim() : raw) || ticket.from_name?.trim() || ''
  const email = (wrapped ? wrapped[2].trim() : '') || ticket.from_email?.trim() || ''
  const shown = name || email
  return { name: shown, email: shown && email && email !== shown ? email : '' }
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatInterval(value: string | null) {
  if (!value) return ''
  const dayMatch = value.match(/(-?\d+)\s+days?/)
  const timeMatch = value.match(/(\d+):(\d+):(\d+)/)
  const days = dayMatch ? Number(dayMatch[1]) : 0
  const hours = timeMatch ? Number(timeMatch[1]) : 0
  if (days >= 1) return hours >= 1 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours >= 1) return `${hours} 小时`
  return '不到 1 小时'
}

function setupHint(err: unknown) {
  const message = err instanceof Error ? err.message : '加载失败'
  const ops = ticketOpsHint(message)
  if (ops) return ops
  if (missingTicketsTable(message)) {
    return '还没有工单表。请在 Supabase SQL Editor 运行 supabase/tickets.sql。'
  }
  if (missingStaffSetup(message)) {
    if (/p_look|hidden|has_claimed|rename_staff|admin_staff_list|set_staff_pin|update_my_look|could not find the function/i.test(message)) {
      return '同事表还是旧的。请在 Supabase SQL Editor 再运行一遍 supabase/staff.sql。'
    }
    return '还没有同事表。请在 Supabase SQL Editor 运行 supabase/staff.sql。'
  }
  return message
}

function MailLoadProgress({ pct, step }: MailReadProgress) {
  return <StepProgress pct={pct} step={step} steps={step === '查到缓存' ? MAIL_CACHE_STEPS : MAIL_STEPS} />
}

function StepProgress({
  pct,
  step,
  steps,
  detail,
}: {
  pct: number
  step: string
  steps: Array<{ pct: number; step: string }>
  detail?: string
}) {
  return (
    <div
      className="mail-loading"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-label={step}
    >
      <p className="lede">
        {step} <span className="mail-loading-pct">{pct}%</span>
        {detail && <span className="mail-loading-detail">{detail}</span>}
      </p>
      <div className="mail-loading-track">
        <span style={{ width: `${pct}%` }} />
      </div>
      <ol className="mail-loading-steps" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {steps.map((item) => {
          const reached = pct >= item.pct
          const current = item.step === step
          return (
            <li
              key={item.step}
              className={current ? 'is-current' : reached ? 'is-done' : undefined}
              aria-current={current ? 'step' : undefined}
            >
              {item.step}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function TicketsListPage() {
  const { folderId } = useParams()
  const navigate = useNavigate()
  const { folders, memberships } = useFolders()
  const { generation, running, status, pct, failed, syncNow } = useMailSync()
  const folder = folders.find((row) => row.id === folderId) ?? null
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [folderTickets, setFolderTickets] = useState<Ticket[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [pool, setPool] = useState<TicketPool>('unassigned')
  const [warehouseId, setWarehouseId] = useState<string | 'all'>('all')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { desk, ready: staffReady } = useStaff()
  const loadSeq = useRef(0)
  const userSeq = useRef(0)
  const filterRef = useRef({ pool, warehouseId })
  filterRef.current = { pool, warehouseId }

  async function reloadTickets(kind: 'nav' | 'user' | 'sync') {
    const seq = ++loadSeq.current
    const seenUser = userSeq.current
    if (kind !== 'sync') userSeq.current += 1
    if (kind === 'nav') {
      setBusy(true)
      setError(null)
    }
    try {
      const rows = await listTickets(filterRef.current)
      if (seq !== loadSeq.current) return
      if (kind === 'sync' && seenUser !== userSeq.current) return
      setTickets(rows)
    } catch (err: unknown) {
      if (kind !== 'sync' && seq === loadSeq.current) setError(setupHint(err))
    } finally {
      if (kind === 'nav' && seq === loadSeq.current) setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void listWarehouses()
      .then((rows) => {
        if (!cancelled) setWarehouses(rows)
      })
      .catch(() => {
        // 仓库读不到时列表照样能看，错误由工单查询报出来
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const seq = ++loadSeq.current
    userSeq.current += 1
    setBusy(true)
    setError(null)
    void listTickets({ pool, warehouseId })
      .then((rows) => {
        if (!cancelled && seq === loadSeq.current) setTickets(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled && seq === loadSeq.current) setError(setupHint(err))
      })
      .finally(() => {
        if (!cancelled && seq === loadSeq.current) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [pool, warehouseId])

  useEffect(() => {
    if (!generation) return
    void reloadTickets('sync')
    // 只跟邮箱对齐的次数走。筛选变化由上面的加载负责。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation])

  useEffect(() => {
    if (!folderId) {
      setFolderTickets([])
      return
    }
    const ids = memberships.filter((item) => item.folder_id === folderId).map((item) => item.ticket_id)
    let cancelled = false
    void listTicketsByIds(ids)
      .then((rows) => {
        if (!cancelled) setFolderTickets(rows.filter((ticket) => ticket.status !== 'done'))
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(setupHint(err))
      })
    return () => {
      cancelled = true
    }
  }, [folderId, memberships])

  if (!staffReady || !desk) {
    return (
      <div className="buddy-page">
        {staffReady ? <DeskGate /> : <p className="lede">在准备领取人…</p>}
        {error && <p className="page-status error">{error}</p>}
      </div>
    )
  }

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <div className="ticket-head">
        <h1>任务池</h1>
        <div className="mail-sync">
          <div className={`mail-sync-bar ${running ? 'is-running' : ''} ${failed ? 'is-failed' : ''}`} role="status">
            <span className="mail-sync-fill" style={{ width: `${running && !failed ? pct : 100}%` }} />
            <span className="mail-sync-label">{running ? `${status} ${pct}%` : status}</span>
          </div>
          <button type="button" className="btn secondary" disabled={running} onClick={syncNow}>
            {running ? '更新中…' : '更新邮件'}
          </button>
        </div>
      </div>
      <p className="lede">未分配是还没分给同事的新任务。客户已经交给某位同事时，对得上的新任务会记到这个人身上。处理中能看到这位同事领走的任务，包括还在等客户的。等待上会标出原因。</p>
      {failed && status && <p className="page-status error">{status}</p>}

      <div className="ticket-filters" aria-label="工单筛选">
        {(
          [
            ['unassigned', '未分配'],
            ['claimed', '处理中'],
            ['waiting', '等待'],
            ['done', '确认完成'],
            ['all', '全部'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`btn small ${pool === key && !(key === 'unassigned' && folderId) ? 'is-picked' : 'ghost'}`}
            onClick={() => {
              if (key === 'unassigned' && folderId) {
                setPool('unassigned')
                navigate('/tickets')
                return
              }
              setPool(key)
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {warehouses.length > 0 && (
        <div className="ticket-filters">
          <button
            type="button"
            className={`btn small ${warehouseId === 'all' ? 'secondary' : 'ghost'}`}
            onClick={() => setWarehouseId('all')}
          >
            所有仓
          </button>
          {warehouses.map((warehouse) => (
            <button
              key={warehouse.id}
              type="button"
              className={`btn small ${warehouseId === warehouse.id ? 'secondary' : 'ghost'}`}
              onClick={() => setWarehouseId(warehouse.id)}
            >
              {warehouse.name}
            </button>
          ))}
        </div>
      )}

      {error && <p className="page-status error">{error}</p>}
      {busy && <p className="page-status">加载工单…</p>}
      <TicketPonds
        tickets={tickets}
        pool={pool}
        folder={folderId ? { id: folderId, name: folder?.name ?? '归类' } : null}
        folderTickets={folderTickets}
        onBack={() => {
          setPool('unassigned')
          navigate('/tickets')
        }}
        onChanged={() => reloadTickets('user')}
      />
    </div>
  )
}

export function TicketsDuePage() {
  const [alerts, setAlerts] = useState<StageAlert[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void Promise.all([listStageAlerts(), listWarehouses()])
      .then(([rows, warehouseRows]) => {
        if (cancelled) return
        setAlerts(rows)
        setWarehouses(warehouseRows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(setupHint(err))
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const warehouseName = (id: string | null) => warehouses.find((row) => row.id === id)?.name

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <div className="ticket-head">
        <h1>提醒</h1>
      </div>
      <p className="lede">当前步骤停得超过设定天数的工单。做完或跳过之后，会从这里消失。</p>
      {error && <p className="page-status error">{error}</p>}
      {busy && <p className="page-status">加载提醒…</p>}
      {!busy && !error && alerts.length === 0 && (
        <p className="lede">现在没有超时的步骤。给工单套上流程，并让当前步骤超过提醒天数后，会出现在这里。</p>
      )}
      <ul className="ticket-list">
        {alerts.map((alert) => (
          <li key={alert.stage_id}>
            <Link className="ticket-card" to={`/tickets/${alert.ticket_id}`}>
              <div className="ticket-card-top">
                <strong>
                  <TicketTitle ticketId={alert.ticket_id} title={alert.title} done={alert.ticket_status === 'done'} />
                </strong>
              </div>
              <TicketStepBar status={alert.ticket_status} />
              <p>
                {alert.stage_status === 'waiting' ? '等待中' : '进行中'}
                {' · '}
                {alert.stage_name}
                {alert.remind_note ? `。${alert.remind_note}` : ''}
              </p>
              <div className="ticket-meta">
                {warehouseName(alert.warehouse_id) && <span>{warehouseName(alert.warehouse_id)}</span>}
                <span>已停留 {formatInterval(alert.stuck_for)}</span>
                <span>超时 {formatInterval(alert.overdue_by)}</span>
                <span>自 {formatWhen(alert.started_at)}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function TicketNewPage() {
  const navigate = useNavigate()
  const { collectAll } = useFolders()
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void listWarehouses()
      .then((rows) => {
        if (cancelled) return
        setWarehouses(rows)
        setWarehouseId(rows.find((row) => row.is_home)?.id ?? rows[0]?.id ?? '')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(setupHint(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const ticket = await createManualTicket({ title, summary, warehouseId: warehouseId || null })
      try {
        await collectAll()
      } catch {
        /* 归类没接上时，工单仍然建好 */
      }
      try {
        await applyAutoClaims()
      } catch {
        /* 自动领取还没建好时，工单仍然建好 */
      }
      navigate(`/tickets/${ticket.id}`)
    } catch (err) {
      setError(setupHint(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <h1>新建工单</h1>
      <p className="lede">没有进邮箱的任务，在这里手写一条。</p>
      <form className="stack-form" onSubmit={(e) => void onSubmit(e)}>
        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        </label>
        <label>
          说明
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={500} />
        </label>
        {warehouses.length > 0 && (
          <label>
            归哪个仓
            <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="page-status error">{error}</p>}
        <button type="submit" className="btn" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
      </form>
    </div>
  )
}

export function TicketDetailPage() {
  const { id } = useParams()
  const { namesByTicket } = useFolders()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [events, setEvents] = useState<TicketEvent[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [stages, setStages] = useState<TicketStage[]>([])
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [letter, setLetter] = useState<MailLetter | null>(null)
  const [letterState, setLetterState] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
  const [letterError, setLetterError] = useState<string | null>(null)
  const [mailProgress, setMailProgress] = useState<MailReadProgress>({ pct: 0, step: '正在送出请求' })
  const [openingFile, setOpeningFile] = useState<number | null>(null)
  const [openingMail, setOpeningMail] = useState(false)
  const [openingMessage, setOpeningMessage] = useState<string | null>(null)
  const [openingMessageFile, setOpeningMessageFile] = useState<string | null>(null)
  const [messages, setMessages] = useState<TicketMessage[] | null | undefined>(undefined)
  const { generation } = useMailSync()
  const { desk, admin } = useStaff()
  const [claimError, setClaimError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [notes, setNotes] = useState<TicketNote[]>([])
  const [noteVersion, setNoteVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!id) return
      setBusy(true)
      setError(null)
      setShowLog(false)
      try {
        const [row, history, sites, flows, stageRows] = await Promise.all([
          getTicket(id),
          listTicketEvents(id),
          listWarehouses(),
          listWorkflows(),
          listTicketStages(id),
        ])
        if (cancelled) return
        setTicket(row)
        setEvents(history)
        setWarehouses(sites)
        setWorkflows(flows)
        setStages(stageRows)
        if (!row) setError('找不到这张工单。')
      } catch (err) {
        if (!cancelled) setError(setupHint(err))
      } finally {
        if (!cancelled) setBusy(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void listTicketNotes(id)
      .then((rows) => {
        if (!cancelled) setNotes(rows)
      })
      .catch(() => {
        if (!cancelled) setNotes([])
      })
    return () => {
      cancelled = true
    }
  }, [id, noteVersion])

  useEffect(() => {
    if (!id) return
    setMessages(undefined)
    let cancelled = false
    void listTicketMessages(id)
      .then((rows) => {
        if (!cancelled) setMessages(rows)
      })
      .catch(() => {
        if (!cancelled) setMessages(null)
      })
    return () => {
      cancelled = true
    }
  }, [id, generation])

  useEffect(() => {
    const firstNeedsLetter = !messages || messages.length === 0 || messages[0].attachments.length === 0
    if (!id || messages === undefined || !ticket?.imap_uid || !firstNeedsLetter) {
      if (messages && messages.length > 0 && messages[0].attachments.length > 0) {
        setLetter(null)
        setLetterState('missing')
      } else if (messages !== undefined && !ticket?.imap_uid) {
        setLetter(null)
        setLetterState(ticket ? 'missing' : 'idle')
      }
      return
    }
    let cancelled = false
    const controller = new AbortController()
    setLetterState('loading')
    setLetterError(null)
    setMailProgress({ pct: 0, step: '正在送出请求' })
    void readMailLetter(
      id,
      (update) => {
        if (!cancelled) setMailProgress(update)
      },
      controller.signal,
    )
      .then((row) => {
        if (cancelled) return
        setLetter(row)
        setLetterState(row ? 'ready' : 'missing')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLetter(null)
        setLetterState('failed')
        setLetterError(err instanceof Error ? err.message : '原信读取失败')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [id, ticket?.imap_uid, messages])

  async function onOpenMessage(messageId: string) {
    if (!id) return
    setOpeningMessage(messageId)
    setLetterError(null)
    try {
      await openOriginalMail(id, messageId)
    } catch (err) {
      setLetterError(err instanceof Error ? err.message : '原邮件没有打开')
    } finally {
      setOpeningMessage(null)
    }
  }

  async function onOpenMessageFile(messageId: string, file: MailFile) {
    if (!id) return
    const tab = window.open('', '_blank')
    const primary = messages?.[0]
    const fromLetter = primary && messageId === primary.id && primary.attachments.length === 0
    setOpeningMessageFile(`${messageId}:${file.index}`)
    setLetterError(null)
    try {
      if (fromLetter) await openMailAttachment(id, file, tab)
      else await openMessageAttachment(id, messageId, file, tab)
    } catch (err) {
      setLetterError(err instanceof Error ? err.message : '附件打开失败')
    } finally {
      setOpeningMessageFile(null)
    }
  }

  async function onOpenOriginal() {
    if (!id) return
    setOpeningMail(true)
    setLetterError(null)
    try {
      await openOriginalMail(id)
    } catch (err) {
      setLetterError(err instanceof Error ? err.message : '原邮件没有打开')
    } finally {
      setOpeningMail(false)
    }
  }

  async function onOpenFile(file: MailFile) {
    if (!id) return
    const tab = window.open('', '_blank')
    setOpeningFile(file.index)
    setLetterError(null)
    try {
      await openMailAttachment(id, file, tab)
    } catch (err) {
      setLetterError(err instanceof Error ? err.message : '附件打开失败')
    } finally {
      setOpeningFile(null)
    }
  }

  async function reloadTicket() {
    if (!id) return
    const [row, history, stageRows] = await Promise.all([
      getTicket(id),
      listTicketEvents(id),
      listTicketStages(id),
    ])
    if (row) setTicket(row)
    setEvents(history)
    setStages(stageRows)
  }

  if (busy) return <p className="page-status">加载工单…</p>
  if (!ticket) return <p className="page-status error">{error}</p>

  const sender = senderOf(letter, ticket)

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <p className="ticket-back">
        <Link to="/tickets">返回列表</Link>
      </p>
      <div className="ticket-head">
        <div className="ticket-title-block">
          {sender.name && (
            <p className="ticket-sender">
              <span className="ticket-avatar" aria-hidden="true">
                {sender.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <span className="ticket-sender-name">{sender.name}</span>
                {sender.email && <span className="ticket-sender-mail">{sender.email}</span>}
              </span>
            </p>
          )}
          <h1>
            <TicketTitle
              ticketId={ticket.id}
              title={letter?.subject || ticket.title}
              done={ticket.status === 'done'}
              colleagues={ticket.assignee ? [ticket.assignee.display_name] : []}
            />
          </h1>
        </div>
      </div>
      <TicketStepBar status={ticket.status} claimedBy={ticket.claimed_by} waitingReason={ticket.waiting_reason} />
      {notes.length > 0 && (
        <section className="task-notes" aria-label="备注">
          <h2>备注</h2>
          <ul>
            {notes.map((note) => (
              <li key={note.id}>
                <p>{note.body}</p>
                <p className="task-note-by">
                  {note.author_name || '同事'}
                  {note.created_at ? ` · ${formatWhen(note.created_at)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {letterError && <p className="page-status error">{letterError}</p>}
      {(messages && messages.length > 0) ? (
        <TicketThread
          ticketId={ticket.id}
          messages={messages}
          openingMail={openingMessage}
          openingFile={openingMessageFile}
          fallbackFiles={messages[0].attachments.length === 0 ? (letter?.attachments ?? []) : []}
          onOpenMail={(messageId) => void onOpenMessage(messageId)}
          onOpenFile={(messageId, file) => void onOpenMessageFile(messageId, file)}
        />
      ) : (
      <>
      {(ticket.imap_uid || ticket.message_id) && (
        <p className="ticket-note">
          <button type="button" className="btn small" disabled={openingMail} onClick={() => void onOpenOriginal()}>
            {openingMail ? '正在交给 Outlook…' : '打开原邮件'}
          </button>
        </p>
      )}
      {(letterState === 'loading' || letterState === 'failed') && (
        <MailLoadProgress pct={mailProgress.pct} step={mailProgress.step} />
      )}
      {ticket.imap_uid ? (
        <article className="mail-sheet">
          <dl>
            <div>
              <dt>收件人</dt>
              <dd>{letter ? letter.to || '—' : letterState === 'loading' ? '读取中…' : '—'}</dd>
            </div>
            {letter?.cc && (
              <div>
                <dt>抄送</dt>
                <dd>{letter.cc}</dd>
              </div>
            )}
            <div>
              <dt>时间</dt>
              <dd>{formatWhen(letter?.date || ticket.received_at) || '—'}</dd>
            </div>
            <div>
              <dt>附件</dt>
              <dd>
                {!letter ? (
                  letterState === 'loading' ? '读取中…' : '原信没读到，暂不知道'
                ) : letter.attachments.length === 0 ? (
                  '无'
                ) : (
                  <>
                    <span className="mail-files-count">{letter.attachments.length} 个</span>
                    <ul className="mail-files">
                      {letter.attachments.map((file) => (
                        <li key={file.index}>
                          <button
                            type="button"
                            className="mail-file"
                            title={`打开 ${file.name}`}
                            disabled={openingFile === file.index}
                            onClick={() => void onOpenFile(file)}
                          >
                            <MailFileIcon name={file.name} type={file.type} />
                            <span className="mail-file-text">
                              <span className="mail-file-name">{file.name}</span>
                              <span className="mail-file-size">
                                {openingFile === file.index ? '打开中…' : formatSize(file.size)}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </dd>
            </div>
          </dl>
          {letter ? (
            <iframe
              className="mail-frame"
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={letter.html}
              title="原信"
            />
          ) : (
            letterState !== 'loading' && (
              <p className="mail-fallback">{ticket.summary || '没有摘录。原信仍在邮箱里。'}</p>
            )
          )}
        </article>
      ) : (
        <p className="lede">
          {ticket.status === 'done'
            ? '已完成。原信仍在邮箱里。'
            : ticket.summary || '没有摘录。'}
        </p>
      )}
      </>
      )}
      <dl className="ticket-facts">
        <div>
          <dt>来源</dt>
          <dd>
            {TICKET_SOURCE_LABEL[ticket.source]}
          </dd>
        </div>
        <div>
          <dt>发件人</dt>
          <dd>{ticket.from_name || ticket.from_email || '—'}</dd>
        </div>
        <div>
          <dt>客户</dt>
          <dd>
            {(namesByTicket.get(ticket.id) ?? [])
              .filter((item) => item.kind === 'customer')
              .map((item) => item.name)
              .join('、') || '—'}
          </dd>
        </div>
        <div>
          <dt>收到</dt>
          <dd>{formatWhen(ticket.received_at) || '—'}</dd>
        </div>
      </dl>

      <TicketJob
        ticket={ticket}
        stages={stages}
        workflows={workflows}
        warehouses={warehouses}
        onChanged={reloadTicket}
        onNoted={() => setNoteVersion((version) => version + 1)}
      />

      {error && <p className="page-status error">{error}</p>}

      <button
        type="button"
        className="btn ticket-log-toggle"
        aria-expanded={showLog}
        onClick={() => setShowLog((open) => !open)}
      >
        操作记录
      </button>
      {showLog && (
        <ol className="ticket-history">
          {events.length === 0 && <li>还没有操作记录</li>}
          {events.map((event) => (
            <li key={event.id}>
              <span>{TICKET_STATUS_LABEL[event.to_status]}</span>
              <span>{event.note || ''}</span>
              <span>{formatWhen(event.created_at)}</span>
            </li>
          ))}
        </ol>
      )}
      {desk && (
        <p className="ticket-note">
          {(() => {
            const current = stages.find((stage) => stage.status === 'active' || stage.status === 'waiting')
            const who = ticket.assignee ? `由 ${ticket.assignee.display_name} 负责` : '还没有人领取'
            return current ? `当前环节是「${current.name}」。${who}` : who
          })()}
          {!ticket.claimed_by && (
            <button
              type="button"
              className="btn small"
              disabled={claiming}
              onClick={() => {
                setClaiming(true)
                setClaimError(null)
                void claimTicket(ticket.id, desk.token)
                  .then(async () => setTicket(await getTicket(ticket.id)))
                  .catch((err: unknown) => setClaimError(err instanceof Error ? err.message : '没有领到'))
                  .finally(() => setClaiming(false))
              }}
            >
              领取任务
            </button>
          )}
          {ticket.claimed_by && (ticket.claimed_by === desk.id || admin) && (
            <button
              type="button"
              className="btn small ghost"
              disabled={claiming}
              onClick={() => {
                setClaiming(true)
                setClaimError(null)
                void releaseTicket(ticket.id, desk.token)
                  .then(async () => setTicket(await getTicket(ticket.id)))
                  .catch((err: unknown) => setClaimError(err instanceof Error ? err.message : '没有放回'))
                  .finally(() => setClaiming(false))
              }}
            >
              放回
            </button>
          )}
        </p>
      )}
      {claimError && <p className="page-status error">{claimError}</p>}
    </div>
  )
}
