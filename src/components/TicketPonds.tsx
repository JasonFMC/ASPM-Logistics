import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CrewFace } from './DeskGate'
import { useStaff } from '../context/StaffContext'
import { claimTicket, reassignTicket, releaseTicket } from '../lib/staff'
import { WAITING_REASON_LABEL } from '../lib/tickets'
import type { Ticket } from '../lib/types'

function formatWhen(value: string | null) {
  if (!value) return ''
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function TicketPonds({
  tickets,
  onChanged,
}: {
  tickets: Ticket[]
  onChanged: () => Promise<void>
}) {
  const { people, desk, admin } = useStaff()
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const open = tickets.filter((ticket) => !ticket.claimed_by)
  const mine = desk?.id

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

  function onDrop(staffId: string, ticketId: string) {
    if (!desk) return
    if (staffId === desk.id) {
      void run(ticketId, () => claimTicket(ticketId, desk.token))
      return
    }
    if (admin) void run(ticketId, () => reassignTicket(ticketId, staffId))
  }

  return (
    <div className="ponds">
      <section className="pond pond-open" aria-label="未分配">
        <h2>未分配</h2>
        <ul>
          {open.map((ticket) => (
            <li key={ticket.id}>
              <article
                className={`float-card${ticket.priority === 'urgent' ? ' is-urgent' : ''}`}
                draggable={Boolean(desk)}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', ticket.id)}
              >
                <Link to={`/tickets/${ticket.id}`}>
                  {(ticket.from_name || ticket.from_email) && (
                    <span className="ticket-card-sender">{ticket.from_name || ticket.from_email}</span>
                  )}
                  <strong>{ticket.title}</strong>
                  <span className="pond-meta">
                    {ticket.priority === 'urgent' && <span className="pond-flag">紧急</span>}
                    {ticket.status === 'waiting' && (
                      <span className="pond-flag">
                        {ticket.waiting_reason ? WAITING_REASON_LABEL[ticket.waiting_reason] : '等待'}
                      </span>
                    )}
                    {ticket.due_at ? `约定 ${formatWhen(ticket.due_at)}` : formatWhen(ticket.received_at || ticket.created_at)}
                  </span>
                </Link>
                {desk && (
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === ticket.id}
                    onClick={() => void run(ticket.id, () => claimTicket(ticket.id, desk.token))}
                  >
                    领取任务
                  </button>
                )}
              </article>
            </li>
          ))}
        </ul>
        {open.length === 0 && <p className="lede">池子空了。</p>}
      </section>
      <section className="pond pond-crew" aria-label="同事">
        <h2>同事</h2>
        <div className="crew-grid">
          {people.map((person) => {
            const taken = tickets.filter((ticket) => ticket.claimed_by === person.id)
            const canDrop = person.id === mine || admin
            return (
              <div
                key={person.id}
                className={`crew ${person.id === mine ? 'is-me' : ''} ${over === person.id ? 'is-over' : ''} ${canDrop ? '' : 'is-locked'}`}
                onDragOver={(event) => {
                  if (!canDrop) return
                  event.preventDefault()
                  setOver(person.id)
                }}
                onDragLeave={() => setOver((current) => (current === person.id ? null : current))}
                onDrop={(event) => {
                  event.preventDefault()
                  setOver(null)
                  const ticketId = event.dataTransfer.getData('text/plain')
                  if (ticketId && canDrop) onDrop(person.id, ticketId)
                }}
              >
                <header>
                  <CrewFace look={person.look} hue={person.hue} name={person.display_name} />
                  <strong>{person.display_name}</strong>
                  {person.id === mine && <span className="crew-me">我</span>}
                </header>
                <ul>
                  {taken.map((ticket) => (
                    <li key={ticket.id}>
                      <Link to={`/tickets/${ticket.id}`}>
                        {ticket.priority === 'urgent' ? '紧急 · ' : ''}
                        {ticket.title}
                      </Link>
                      {desk && (person.id === mine || admin) && (
                        <button
                          type="button"
                          className="btn tiny ghost"
                          disabled={busyId === ticket.id}
                          onClick={() =>
                            void run(ticket.id, () =>
                              admin && person.id !== mine
                                ? reassignTicket(ticket.id, null)
                                : releaseTicket(ticket.id, desk.token),
                            )
                          }
                        >
                          放回
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
        {people.length === 0 && <p className="lede">还没有同事。</p>}
      </section>
      {error && <p className="page-status error">{error}</p>}
    </div>
  )
}
