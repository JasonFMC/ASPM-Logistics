import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useStaff } from '../context/StaffContext'
import {
  addTicketNote,
  applyWorkflow,
  describeTarget,
  finishStage,
  saveTicketJob,
  searchYard,
  setTicketStatus,
  setTicketTarget,
  setTicketWarehouse,
  ticketOpsHint,
  WAITING_REASON_LABEL,
  type YardItemHit,
  type YardPlaceHit,
} from '../lib/tickets'
import type {
  Ticket,
  TicketStage,
  WaitingReason,
  Warehouse,
  Workflow,
} from '../lib/types'

const REASONS = Object.keys(WAITING_REASON_LABEL) as WaitingReason[]

const STAGE_LABEL: Record<TicketStage['status'], string> = {
  pending: '未开始',
  active: '进行中',
  waiting: '等待中',
  done: '已完成',
  skipped: '已跳过',
}

function formatWhen(value: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function toLocalInput(value: string | null | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fromLocalInput(value: string) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function hint(err: unknown) {
  const message = err instanceof Error ? err.message : '没有保存'
  return ticketOpsHint(message) ?? message
}

export function TicketJob({
  ticket,
  stages,
  workflows,
  warehouses,
  onChanged,
  onNoted,
}: {
  ticket: Ticket
  stages: TicketStage[]
  workflows: Workflow[]
  warehouses: Warehouse[]
  onChanged: () => Promise<void>
  onNoted: () => void
}) {
  const { desk } = useStaff()
  const [reason, setReason] = useState<WaitingReason>(ticket.waiting_reason ?? 'customer')
  const [reference, setReference] = useState(ticket.facts?.reference ?? '')
  const [qty, setQty] = useState(ticket.facts?.qty ?? '')
  const [factNote, setFactNote] = useState(ticket.facts?.note ?? '')
  const [due, setDue] = useState(toLocalInput(ticket.due_at))
  const [urgent, setUrgent] = useState(ticket.priority === 'urgent')
  const [workflowId, setWorkflowId] = useState(ticket.workflow_id || workflows[0]?.id || '')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<{ items: YardItemHit[]; locations: YardPlaceHit[] }>({ items: [], locations: [] })
  const [itemLabel, setItemLabel] = useState('')
  const [placeLabel, setPlaceLabel] = useState('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setReason(ticket.waiting_reason ?? 'customer')
    setReference(ticket.facts?.reference ?? '')
    setQty(ticket.facts?.qty ?? '')
    setFactNote(ticket.facts?.note ?? '')
    setDue(toLocalInput(ticket.due_at))
    setUrgent(ticket.priority === 'urgent')
    setWorkflowId(ticket.workflow_id || workflows[0]?.id || '')
  }, [ticket, workflows])

  useEffect(() => {
    let cancelled = false
    void describeTarget(ticket)
      .then((row) => {
        if (cancelled) return
        setItemLabel(row.item ? `${row.item.code}${row.item.name ? ` ${row.item.name}` : ''}` : '')
        setPlaceLabel(row.place ? `${row.place.code}${row.place.label ? ` ${row.place.label}` : ''}` : '')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(hint(err))
      })
    return () => {
      cancelled = true
    }
  }, [ticket])

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await onChanged()
    } catch (err) {
      setError(hint(err))
    } finally {
      setBusy(false)
    }
  }

  const hasStages = stages.length > 0
  const stageOpen = stages.some((stage) => stage.status === 'pending' || stage.status === 'active' || stage.status === 'waiting')
  const closed = ticket.status === 'done' || ticket.status === 'cancelled'

  return (
    <div className="ticket-job">
      <section>
        <h2>这张单现在</h2>
        <p className="ticket-note">
          {hasStages
            ? '状态跟着当前环节走。领取人就是这一步的负责人，要交给别人就放回。'
            : '还没套流程时，用下面的按钮推进。套上以后就改由环节决定。'}
        </p>
        {ticket.status === 'waiting' && (
          <p className="ticket-note">
            等待：{ticket.waiting_reason ? WAITING_REASON_LABEL[ticket.waiting_reason] : '当前环节在等'}
          </p>
        )}
        {!closed && (ticket.status === 'new' || ticket.status === 'in_progress') && (
          <label className="ticket-warehouse">
            等待原因
            <select value={reason} disabled={busy} onChange={(e) => setReason(e.target.value as WaitingReason)}>
              {REASONS.map((key) => (
                <option key={key} value={key}>
                  {WAITING_REASON_LABEL[key]}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ticket-actions">
          {ticket.status === 'new' && !hasStages && (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(() => setTicketStatus(ticket, 'in_progress').then(() => undefined))}>
              开始处理
            </button>
          )}
          {(ticket.status === 'new' || ticket.status === 'in_progress') && (
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => void run(() => setTicketStatus(ticket, 'waiting', { reason }).then(() => undefined))}
            >
              标为等待
            </button>
          )}
          {ticket.status === 'waiting' && (
            <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(() => setTicketStatus(ticket, 'in_progress').then(() => undefined))}>
              继续处理
            </button>
          )}
          {!stageOpen && !closed && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => setTicketStatus(ticket, 'done').then(() => undefined))}>
              完成
            </button>
          )}
          {!hasStages && ticket.status === 'in_progress' && (
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void run(() => setTicketStatus(ticket, 'new').then(() => undefined))}>
              退回待处理
            </button>
          )}
          {!closed && (
            <button
              type="button"
              className="btn ghost"
              disabled={busy}
              onClick={() => void run(() => setTicketStatus(ticket, 'cancelled', { note: '取消工单' }).then(() => undefined))}
            >
              取消
            </button>
          )}
          {closed && (
            <button type="button" className="btn" disabled={busy} onClick={() => void run(() => setTicketStatus(ticket, 'in_progress').then(() => undefined))}>
              重新打开
            </button>
          )}
        </div>
        {warehouses.length > 0 && (
          <label className="ticket-warehouse">
            归哪个仓
            <select
              value={ticket.warehouse_id ?? ''}
              disabled={busy}
              onChange={(e) => void run(() => setTicketWarehouse(ticket.id, e.target.value || null).then(() => undefined))}
            >
              <option value="">未分</option>
              {warehouses.map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      <section>
        <h2>作业内容</h2>
        <p className="ticket-note">
          {ticket.facts_confirmed_at ? `已于 ${formatWhen(ticket.facts_confirmed_at)} 确认。` : '还没确认。确认过的才算这张单的作业内容。'}
        </p>
        <div className="job-fields">
          <label>
            单号
            <input value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} />
          </label>
          <label>
            数量
            <input value={qty} maxLength={40} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label>
            约定时间
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <label>
            备注在作业里
            <input value={factNote} maxLength={200} onChange={(e) => setFactNote(e.target.value)} />
          </label>
          <label className="job-check">
            <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
            紧急
          </label>
        </div>
        <div className="ticket-actions">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              void run(() =>
                saveTicketJob(ticket.id, {
                  facts: { reference, qty, note: factNote },
                  dueAt: fromLocalInput(due),
                  priority: urgent ? 'urgent' : 'normal',
                  confirm: false,
                }).then(() => undefined),
              )
            }
          >
            存成草稿
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(() =>
                saveTicketJob(ticket.id, {
                  facts: { reference, qty, note: factNote },
                  dueAt: fromLocalInput(due),
                  priority: urgent ? 'urgent' : 'normal',
                  confirm: true,
                }).then(() => undefined),
              )
            }
          >
            确认作业
          </button>
        </div>
      </section>

      <section>
        <h2>对上院子</h2>
        <p className="ticket-note">
          {itemLabel ? (
            <>
              货：{ticket.item_id ? <Link to={`/yard/item/${ticket.item_id}`}>{itemLabel}</Link> : itemLabel}
            </>
          ) : (
            '还没对上货。'
          )}
          {placeLabel ? ` 位置：${placeLabel}` : ''}
        </p>
        <form
          className="ticket-actions"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void run(async () => {
              setHits(await searchYard(query))
            })
          }}
        >
          <input value={query} placeholder="货号或位置" onChange={(e) => setQuery(e.target.value)} />
          <button type="submit" className="btn small secondary" disabled={busy || !query.trim()}>
            查找
          </button>
          {(ticket.item_id || ticket.location_id) && (
            <button
              type="button"
              className="btn small ghost"
              disabled={busy}
              onClick={() => void run(() => setTicketTarget(ticket.id, null, null).then(() => undefined))}
            >
              清除
            </button>
          )}
        </form>
        {hits.items.length > 0 && (
          <ul className="note-list">
            {hits.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() => setTicketTarget(ticket.id, item.id, item.location_id).then(() => undefined))
                  }
                >
                  货 {item.code}
                  {item.name ? ` ${item.name}` : ''}
                </button>
              </li>
            ))}
          </ul>
        )}
        {hits.locations.length > 0 && (
          <ul className="note-list">
            {hits.locations.map((place) => (
              <li key={place.id}>
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() => setTicketTarget(ticket.id, ticket.item_id ?? null, place.id).then(() => undefined))
                  }
                >
                  位置 {place.code}
                  {place.label ? ` ${place.label}` : ''}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>流程</h2>
        {!hasStages ? (
          <div className="ticket-actions">
            <label className="ticket-warehouse">
              套用哪条流程
              <select value={workflowId} disabled={busy} onChange={(e) => setWorkflowId(e.target.value)}>
                {workflows.map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || !workflowId}
              onClick={() => void run(() => applyWorkflow(ticket.id, workflowId))}
            >
              套用流程
            </button>
          </div>
        ) : (
          <ol className="ticket-history">
            {stages.map((stage) => (
              <li key={stage.id}>
                <span>{stage.name}</span>
                <span>
                  {STAGE_LABEL[stage.status]}
                  {stage.optional ? ' · 可跳过' : ''}
                </span>
                {(stage.status === 'active' || stage.status === 'waiting') && !closed && (
                  <span className="ticket-actions">
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => void run(() => finishStage(stage, 'done'))}
                    >
                      这一步完成
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      disabled={busy}
                      onClick={() => void run(() => finishStage(stage, 'skipped'))}
                    >
                      跳过
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h2>备注</h2>
        <p className="ticket-note">写给下一位的话。保存后出现在消息前面。备注不改状态。</p>
        <form
          className="job-fields"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            const text = draft
            void run(async () => {
              await addTicketNote(ticket.id, text, desk?.id ?? null, desk?.display_name ?? '同事')
              setDraft('')
              onNoted()
            })
          }}
        >
          <label>
            写一句
            <textarea value={draft} maxLength={500} rows={3} onChange={(e) => setDraft(e.target.value)} />
          </label>
          <button type="submit" className="btn small" disabled={busy || !draft.trim()}>
            写备注
          </button>
        </form>
      </section>
      {error && <p className="page-status error">{error}</p>}
    </div>
  )
}
