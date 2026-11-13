import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { CrewFace } from './DeskGate'
import { useFolders } from '../context/FolderContext'
import { folderSetupHint } from '../lib/folders'
import { useStaff } from '../context/StaffContext'
import { claimTicket, helpColleague, leaveHelp, listTicketHelpers, releaseTicket, reassignTicket } from '../lib/staff'
import { WAITING_REASON_LABEL, type TicketPool } from '../lib/tickets'
import { TicketStepBar } from './TicketStepBar'
import { TicketTitle } from './TicketTitle'
import type { Ticket } from '../lib/types'

const DRAG_SLOP = 6

function formatWhen(value: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function finishedAt(ticket: Ticket) {
  return ticket.closed_at || ticket.updated_at
}

function arrivedAt(ticket: Ticket) {
  return ticket.received_at || ticket.created_at
}

function dayKey(value: string) {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function dayLabel(value: string) {
  return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

function placeGhost(node: HTMLElement, x: number, y: number, hot: boolean) {
  const scale = hot ? 0.56 : 0.72
  const tilt = hot ? 0 : -6
  node.style.transform = `translate(${x}px, ${y}px) translate(-40%, -28%) scale(${scale}) rotate(${tilt}deg)`
}

interface DropTarget {
  kind: 'staff' | 'folder'
  id: string
}

function targetAt(x: number, y: number): DropTarget | null {
  const hit = document.elementFromPoint(x, y)
  const folderId = hit?.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId
  if (folderId) return { kind: 'folder', id: folderId }
  const staffId = hit?.closest<HTMLElement>('[data-staff-id]')?.dataset.staffId
  if (staffId) return { kind: 'staff', id: staffId }
  return null
}

function paintFolder(id: string | null) {
  document.querySelectorAll<HTMLElement>('[data-folder-id].is-over').forEach((node) => node.classList.remove('is-over'))
  if (!id) return
  document.querySelector<HTMLElement>(`[data-folder-id="${CSS.escape(id)}"]`)?.classList.add('is-over')
}

function stopNativeDrag(event: { preventDefault: () => void; stopPropagation: () => void }) {
  event.preventDefault()
  event.stopPropagation()
}

function claimedGroups(
  personId: string,
  taken: Ticket[],
  folders: Array<{ id: string; name: string; kind: string; claim_staff_id: string | null }>,
  memberships: Array<{ folder_id: string; ticket_id: string }>,
) {
  const byFolder = new Map(folders.map((folder) => [folder.id, folder]))
  const owned = new Map<string, string>()
  const any = new Map<string, string[]>()
  for (const item of memberships) {
    const folder = byFolder.get(item.folder_id)
    if (!folder || folder.kind !== 'customer') continue
    const names = any.get(item.ticket_id) ?? []
    names.push(folder.name)
    any.set(item.ticket_id, names)
    if (folder.claim_staff_id === personId) {
      const current = owned.get(item.ticket_id)
      if (!current || folder.name.localeCompare(current, 'zh') < 0) owned.set(item.ticket_id, folder.name)
    }
  }
  const groups = new Map<string, Ticket[]>()
  for (const ticket of taken) {
    const names = any.get(ticket.id)
    const label = owned.get(ticket.id) ?? (names ? [...names].sort((a, b) => a.localeCompare(b, 'zh'))[0] : '') ?? ''
    const rows = groups.get(label) ?? []
    rows.push(ticket)
    groups.set(label, rows)
  }
  return [...groups.entries()].sort((a, b) => {
    if (!a[0]) return 1
    if (!b[0]) return -1
    return a[0].localeCompare(b[0], 'zh')
  })
}

interface DragCard {
  id: string
  title: string
  sender: string
  urgent: boolean
}

export function TicketPonds({
  tickets,
  pool,
  folder,
  folderTickets,
  onBack,
  onChanged,
}: {
  tickets: Ticket[]
  pool: TicketPool
  folder: { id: string; name: string } | null
  folderTickets: Ticket[]
  onBack: () => void
  onChanged: () => Promise<void>
}) {
  const { people, desk, admin } = useStaff()
  const { folders, memberships, place, takeOut } = useFolders()
  const keptOut = useMemo(() => {
    const hiddenFolders = new Set(folders.filter((item) => item.show_unassigned === false).map((item) => item.id))
    const ids = new Set<string>()
    for (const item of memberships) {
      if (hiddenFolders.has(item.folder_id)) ids.add(item.ticket_id)
    }
    return ids
  }, [folders, memberships])
  const [helpers, setHelpers] = useState<Map<string, Array<{ staffId: string; name: string }>>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [over, setOver] = useState<DropTarget | null>(null)
  const [drag, setDrag] = useState<DragCard | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const originRef = useRef<DOMRect | null>(null)
  const pointRef = useRef({ x: 0, y: 0 })
  const overRef = useRef<DropTarget | null>(null)
  const settleRef = useRef<number | null>(null)
  const settlingRef = useRef(false)
  const releasePointer = useRef<(() => void) | null>(null)
  const open = folder
    ? folderTickets.filter((ticket) => ticket.status !== 'done')
    : pool === 'done' || pool === 'waiting'
      ? tickets
      : pool === 'all'
        ? tickets.filter((ticket) => ticket.status === 'done' || !ticket.claimed_by)
        : tickets.filter((ticket) => !ticket.claimed_by && (pool !== 'unassigned' || !keptOut.has(ticket.id)))
  const showOpen = Boolean(folder) || pool === 'unassigned' || pool === 'all' || pool === 'done' || pool === 'waiting' || (pool !== 'claimed' && open.length > 0)
  const columnTitle = folder ? folder.name : pool === 'done' ? '确认完成' : pool === 'waiting' ? '等待' : '未分配'
  const doneBoard = pool === 'done' && !folder
  const dateBoard = pool === 'unassigned' && !folder
  const listed = doneBoard
    ? [...open].sort((a, b) => Date.parse(finishedAt(b)) - Date.parse(finishedAt(a)))
    : dateBoard
      ? [...open].sort((a, b) => Date.parse(arrivedAt(b)) - Date.parse(arrivedAt(a)))
      : open
  const mine = desk?.id

  useEffect(() => {
    const ids = [...tickets, ...folderTickets].map((ticket) => ticket.id)
    if (!ids.length) {
      setHelpers(new Map())
      return
    }
    let cancelled = false
    void listTicketHelpers(ids)
      .then((rows) => {
        if (cancelled) return
        const map = new Map<string, Array<{ staffId: string; name: string }>>()
        for (const row of rows) {
          const list = map.get(row.ticketId) ?? []
          if (row.name) list.push({ staffId: row.staffId, name: row.name })
          map.set(row.ticketId, list)
        }
        setHelpers(map)
      })
      .catch(() => {
        if (!cancelled) setHelpers(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [tickets, folderTickets])

  function colleagueNames(ticket: Ticket) {
    const names = ticket.assignee ? [ticket.assignee.display_name] : []
    for (const helper of helpers.get(ticket.id) ?? []) {
      if (helper.name && !names.includes(helper.name)) names.push(helper.name)
    }
    return names
  }

  function allowedStaff(staffId: string | null) {
    if (!staffId || !desk) return null
    if (staffId === desk.id || admin) return staffId
    return null
  }

  useLayoutEffect(() => {
    if (!drag) return
    const node = ghostRef.current
    const origin = originRef.current
    if (!node || !origin) return

    document.body.classList.add('is-lifting-ticket')
    node.style.width = `${origin.width}px`
    node.style.opacity = '1'
    node.style.transition = 'none'
    node.style.transform = `translate(${origin.left}px, ${origin.top}px) scale(1)`

    const frame = requestAnimationFrame(() => {
      if (settlingRef.current) return
      node.style.transition = 'transform 0.22s cubic-bezier(.2, .8, .2, 1)'
      placeGhost(node, pointRef.current.x, pointRef.current.y, Boolean(overRef.current))
    })
    const loosen = window.setTimeout(() => {
      if (settlingRef.current || !ghostRef.current) return
      ghostRef.current.style.transition = 'transform 0.07s linear'
    }, 220)

    return () => {
      document.body.classList.remove('is-lifting-ticket')
      cancelAnimationFrame(frame)
      window.clearTimeout(loosen)
    }
  }, [drag])

  useEffect(() => {
    return () => {
      if (settleRef.current) window.clearTimeout(settleRef.current)
      releasePointer.current?.()
    }
  }, [])

  async function run(ticketId: string, action: () => Promise<void>) {
    setBusyId(ticketId)
    setError(null)
    try {
      await action()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '没有领到')
    } finally {
      setBusyId(null)
    }
  }

  function giveTicket(staffId: string, ticketId: string) {
    if (!desk) return
    if (staffId === desk.id) {
      void run(ticketId, () => claimTicket(ticketId, desk.token))
      return
    }
    if (admin) void run(ticketId, () => reassignTicket(ticketId, staffId))
  }

  function follow(x: number, y: number) {
    pointRef.current = { x, y }
    const hit = targetAt(x, y)
    const next = hit?.kind === 'staff' ? (allowedStaff(hit.id) ? hit : null) : hit
    const same = overRef.current?.kind === next?.kind && overRef.current?.id === next?.id
    if (!same) {
      overRef.current = next
      setOver(next)
      paintFolder(next?.kind === 'folder' ? next.id : null)
    }
    const node = ghostRef.current
    if (node) placeGhost(node, x, y, Boolean(next))
  }

  function settle(ticketId: string) {
    settlingRef.current = true
    const node = ghostRef.current
    const land = overRef.current
    const origin = originRef.current
    paintFolder(null)
    if (node && land) {
      const selector = land.kind === 'folder' ? `[data-folder-id="${CSS.escape(land.id)}"]` : `[data-staff-id="${CSS.escape(land.id)}"]`
      const box = document.querySelector(selector)?.getBoundingClientRect()
      node.style.transition = 'transform 0.24s cubic-bezier(.2, .8, .2, 1), opacity 0.24s ease'
      if (box) {
        node.style.transform = `translate(${box.left + box.width / 2}px, ${box.top + 36}px) translate(-50%, -50%) scale(0.12)`
      }
      node.style.opacity = '0'
      if (land.kind === 'folder') {
        void place(land.id, ticketId).catch((err: unknown) => setError(folderSetupHint(err)))
      } else {
        giveTicket(land.id, ticketId)
      }
    } else if (node && origin) {
      node.style.transition = 'transform 0.28s cubic-bezier(.2, .8, .2, 1)'
      node.style.transform = `translate(${origin.left}px, ${origin.top}px) scale(1) rotate(0deg)`
    }
    settleRef.current = window.setTimeout(() => {
      setDrag(null)
      setOver(null)
      overRef.current = null
      settlingRef.current = false
    }, land ? 240 : 280)
  }

  function onCardPointerDown(event: ReactPointerEvent<HTMLElement>, ticket: Ticket) {
    if (!desk || event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    if (settleRef.current) window.clearTimeout(settleRef.current)

    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    const card = event.currentTarget
    let lifted = false

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId || settlingRef.current) return
      if (!lifted) {
        const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY)
        if (distance < DRAG_SLOP) return
        lifted = true
        settlingRef.current = false
        originRef.current = card.getBoundingClientRect()
        pointRef.current = { x: moveEvent.clientX, y: moveEvent.clientY }
        overRef.current = null
        setOver(null)
        setDrag({
          id: ticket.id,
          title: ticket.title,
          sender: ticket.from_name || ticket.from_email || '',
          urgent: ticket.priority === 'urgent',
        })
      }
      follow(moveEvent.clientX, moveEvent.clientY)
    }

    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      release()
      if (!lifted) return
      window.addEventListener('click', stopNativeDrag, { capture: true, once: true })
      settle(ticket.id)
    }

    const release = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      releasePointer.current = null
    }

    releasePointer.current = release
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div className={`ponds${showOpen ? '' : ' is-crew-only'}${doneBoard ? ' is-done-only' : ''}`}>
      {error && <p className="page-status error">{error}</p>}
      {showOpen && (
      <section className="pond pond-open" aria-label={columnTitle}>
        <div className="pond-head">
          <h2>{columnTitle}</h2>
          {folder && (
            <div className="pond-card-actions">
              {desk && (
                <Link to={`/folders/${folder.id}`} className="btn small ghost">
                  编辑
                </Link>
              )}
              <button type="button" className="btn small ghost" onClick={onBack}>
                返回
              </button>
            </div>
          )}
        </div>
        <ul>
          {listed.map((ticket, index) => {
            const doneAt = finishedAt(ticket)
            const groupAt = doneBoard ? doneAt : arrivedAt(ticket)
            const previous = index > 0 ? (doneBoard ? finishedAt(listed[index - 1]) : arrivedAt(listed[index - 1])) : ''
            const showDay = (doneBoard || dateBoard) && (index === 0 || dayKey(groupAt) !== dayKey(previous))
            return (
            <li key={ticket.id}>
              {showDay && <h3 className="done-day">{dayLabel(groupAt)}</h3>}
              <article
                className={`float-card${ticket.status === 'done' ? ' is-settled' : ''}${ticket.priority === 'urgent' ? ' is-urgent' : ''}${drag?.id === ticket.id ? ' is-source' : ''}`}
                onPointerDown={ticket.status === 'done' ? undefined : (event) => onCardPointerDown(event, ticket)}
                onDragStart={stopNativeDrag}
              >
                <Link to={`/tickets/${ticket.id}`} draggable={false} onDragStart={stopNativeDrag}>
                  {(ticket.from_name || ticket.from_email) && (
                    <span className="ticket-card-sender">{ticket.from_name || ticket.from_email}</span>
                  )}
                  <strong>
                    <TicketTitle
                      ticketId={ticket.id}
                      title={ticket.title}
                      done={ticket.status === 'done'}
                      colleagues={colleagueNames(ticket)}
                    />
                    {(ticket.mail_count ?? 0) > 0 && <span className="mail-count">{ticket.mail_count} 封</span>}
                  </strong>
                  <TicketStepBar
                    status={ticket.status}
                    claimedBy={ticket.claimed_by}
                    waitingReason={ticket.waiting_reason}
                    compact
                  />
                  <span className="pond-meta">
                    {ticket.priority === 'urgent' && <span className="pond-flag">紧急</span>}
                    {ticket.status === 'waiting' && (
                      <span className="pond-flag">
                        {ticket.waiting_reason ? WAITING_REASON_LABEL[ticket.waiting_reason] : '等待'}
                      </span>
                    )}
                    {doneBoard ? (
                      <>
                        <span>
                          {ticket.received_at
                            ? `邮件 ${formatWhen(ticket.received_at)}`
                            : `建立 ${formatWhen(ticket.created_at)}`}
                        </span>
                        <span>完成 {formatWhen(doneAt)}</span>
                      </>
                    ) : ticket.due_at ? (
                      `约定 ${formatWhen(ticket.due_at)}`
                    ) : (
                      formatWhen(ticket.received_at || ticket.created_at)
                    )}
                  </span>
                </Link>
                {desk && (
                  <div className="pond-card-actions">
                    {!ticket.claimed_by && ticket.status !== 'done' && (
                      <button
                        type="button"
                        className="btn small"
                        disabled={busyId === ticket.id}
                        onClick={() => void run(ticket.id, () => claimTicket(ticket.id, desk.token))}
                      >
                        领取任务
                      </button>
                    )}
                    {folder && (
                      <button
                        type="button"
                        className="btn small ghost"
                        onClick={() => void takeOut(folder.id, ticket.id).catch((err: unknown) => setError(folderSetupHint(err)))}
                      >
                        移出
                      </button>
                    )}
                  </div>
                )}
              </article>
            </li>
            )
          })}
        </ul>
        {open.length === 0 && (
          <p className="lede">
            {folder ? '还没有收录的任务。' : pool === 'done' ? '还没有确认完成的任务。' : pool === 'waiting' ? '还没有等待中的任务。' : '任务池空了。'}
          </p>
        )}
      </section>
      )}
      {!doneBoard && <section className="pond pond-crew" aria-label="同事">
        <h2>同事</h2>
        <div className="crew-grid">
          {people.map((person) => {
            const taken = tickets.filter((ticket) => ticket.claimed_by === person.id && ticket.status !== 'done')
            const groups = claimedGroups(person.id, taken, folders, memberships)
            const showCustomer = groups.some(([name]) => name)
            const canDrop = person.id === mine || admin
            const hot = over?.kind === 'staff' && over.id === person.id
            return (
              <div
                key={person.id}
                data-staff-id={person.id}
                className={`crew ${person.id === mine ? 'is-me' : ''} ${hot ? 'is-over' : ''} ${canDrop ? '' : 'is-locked'}`}
              >
                <header>
                  <CrewFace look={person.look} hue={person.hue} name={person.display_name} />
                  <strong>{person.display_name}</strong>
                  {person.id === mine && <span className="crew-me">我</span>}
                  {(person.id === mine || admin) && (
                    <Link to={`/tickets/claim/${person.id}`} className="btn tiny ghost crew-claim">
                      自动领取
                    </Link>
                  )}
                </header>
                <ul>
                  {groups.map(([name, rows]) => (
                    <li key={name || 'other'} className={showCustomer ? 'crew-bundle' : 'crew-plain'}>
                      {showCustomer && (
                        <p className="crew-customer">
                          {name || '其他'}
                          <span>{rows.length}</span>
                        </p>
                      )}
                      <ul>
                  {rows.map((ticket) => (
                    <li key={ticket.id}>
                      <Link
                        to={`/tickets/${ticket.id}`}
                        draggable={false}
                        onDragStart={stopNativeDrag}
                        onPointerDown={(event) => onCardPointerDown(event, ticket)}
                      >
                        <span>
                          {ticket.priority === 'urgent' ? '紧急 · ' : ''}
                          <TicketTitle
                            ticketId={ticket.id}
                            title={ticket.title}
                            done={ticket.status === 'done'}
                            colleagues={colleagueNames(ticket)}
                          />
                          {(ticket.mail_count ?? 0) > 0 && <span className="mail-count">{ticket.mail_count} 封</span>}
                        </span>
                        <TicketStepBar
                          status={ticket.status}
                          claimedBy={ticket.claimed_by}
                          waitingReason={ticket.waiting_reason}
                          compact
                        />
                      </Link>
                      {desk && person.id === mine && (
                        <button
                          type="button"
                          className="btn tiny ghost"
                          disabled={busyId === ticket.id}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => void run(ticket.id, () => releaseTicket(ticket.id, desk.token))}
                        >
                          放回
                        </button>
                      )}
                      {desk && person.id !== mine && ticket.status !== 'cancelled' && (
                        <button
                          type="button"
                          className="btn tiny ghost"
                          disabled={busyId === ticket.id}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => {
                            const helping = (helpers.get(ticket.id) ?? []).some((helper) => helper.staffId === mine)
                            void run(ticket.id, () =>
                              helping ? leaveHelp(ticket.id, desk.token) : helpColleague(ticket.id, desk.token),
                            )
                          }}
                        >
                          {(helpers.get(ticket.id) ?? []).some((helper) => helper.staffId === mine) ? '不帮了' : '帮助同事'}
                        </button>
                      )}
                    </li>
                  ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        {people.length === 0 && <p className="lede">还没有同事。</p>}
      </section>}
      {drag && (
        <div
          ref={ghostRef}
          className={`drag-ghost${drag.urgent ? ' is-urgent' : ''}${over ? ' is-hot' : ''}`}
          aria-hidden="true"
        >
          {drag.sender && <span className="ticket-card-sender">{drag.sender}</span>}
          <strong>{drag.title}</strong>
          <span className="pond-meta">
            {over?.kind === 'folder' ? '松手归入' : over ? '松手放下' : '拖到同事或左侧文件夹'}
          </span>
        </div>
      )}
    </div>
  )
}
