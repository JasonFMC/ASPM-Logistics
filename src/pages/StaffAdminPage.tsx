import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { CrewFace } from '../components/DeskGate'
import { TicketTitle } from '../components/TicketTitle'
import { useStaff } from '../context/StaffContext'
import {
  deleteStaff,
  listAdminStaff,
  missingStaffSetup,
  renameStaff,
  setStaffHidden,
  setStaffPin,
  type AdminStaff,
} from '../lib/staff'

function hint(err: unknown) {
  const message = err instanceof Error ? err.message : '加载失败'
  if (missingStaffSetup(message)) {
    return '同事表还是旧的。请在 Supabase SQL Editor 再运行一遍 supabase/staff.sql。'
  }
  return message
}

export function StaffAdminPage() {
  const { admin, ready, refresh } = useStaff()
  const [rows, setRows] = useState<AdminStaff[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pins, setPins] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  async function load() {
    const list = await listAdminStaff()
    setRows(list)
    setDrafts(Object.fromEntries(list.map((person) => [person.id, person.display_name])))
  }

  useEffect(() => {
    if (!ready || !admin) return
    let cancelled = false
    const run = () => {
      void load().catch((err) => {
        if (!cancelled) setError(hint(err))
      })
    }
    run()
    const onShow = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onShow)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onShow)
    }
  }, [ready, admin])

  async function run(id: string, action: () => Promise<void>) {
    setBusyId(id)
    setError(null)
    try {
      await action()
      await load()
      await refresh()
    } catch (err) {
      setError(hint(err))
    } finally {
      setBusyId(null)
    }
  }

  if (!ready) return <p className="page-status">加载中…</p>
  if (!admin) return <Navigate to="/tickets" replace />

  return (
    <div className="module-page ticket-page">
      <p className="eyebrow">Tickets</p>
      <h1>员工</h1>
      <p className="lede">
        员工自己改过的名字和密码会显示在这里。这次更新之前设的密码，要等本人或管理员改一次才会出现。改名后还是同一个账号，已经领的工单留在这个人身上。改密码后，这个人要重新输入新密码才能进入。隐藏后，领取人列表和任务池里不再出现这个人，工单也不会退回未领取。只有从没领过工单的人可以删除。
      </p>
      {error && <p className="page-status error">{error}</p>}
      {rows.length === 0 && !error && <p className="lede">还没有员工。</p>}
      <div className="staff-admin">
        {rows.map((person) => {
          const held = person.has_claimed || person.open_count > 0
          return (
            <article key={person.id} className={`staff-row ${person.hidden ? 'is-hidden' : ''}`}>
              <CrewFace look={person.look} hue={person.hue} name={person.display_name} mid />
              <div>
                <header>
                  <strong>{person.display_name}</strong>
                  <span>接单 {person.open_count}</span>
                  <span>密码 {person.pin ?? '改密后显示'}</span>
                  {person.hidden && <span className="staff-flag">已隐藏</span>}
                </header>
                <div className="staff-actions">
                  <input
                    value={drafts[person.id] ?? person.display_name}
                    maxLength={20}
                    aria-label={`${person.display_name} 的名字`}
                    onChange={(event) => setDrafts((current) => ({ ...current, [person.id]: event.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === person.id || (drafts[person.id] ?? '').trim() === person.display_name}
                    onClick={() => void run(person.id, () => renameStaff(person.id, (drafts[person.id] ?? '').trim()))}
                  >
                    改名
                  </button>
                  <input
                    value={pins[person.id] ?? ''}
                    maxLength={20}
                    autoComplete="off"
                    placeholder="新密码"
                    aria-label={`${person.display_name} 的新密码`}
                    onChange={(event) => setPins((current) => ({ ...current, [person.id]: event.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === person.id || (pins[person.id] ?? '').trim().length < 4}
                    onClick={() =>
                      void run(person.id, async () => {
                        await setStaffPin(person.id, (pins[person.id] ?? '').trim())
                        setPins((current) => ({ ...current, [person.id]: '' }))
                      })
                    }
                  >
                    改密码
                  </button>
                  <Link to={`/tickets/claim/${person.id}`} className="btn small ghost">
                    自动领取
                  </Link>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={busyId === person.id}
                    onClick={() => void run(person.id, () => setStaffHidden(person.id, !person.hidden))}
                  >
                    {person.hidden ? '恢复显示' : '隐藏'}
                  </button>
                  {held ? (
                    <span className="staff-note">领取过工单，不能删除</span>
                  ) : confirmId === person.id ? (
                    <button
                      type="button"
                      className="btn small danger"
                      disabled={busyId === person.id}
                      onClick={() => void run(person.id, () => deleteStaff(person.id))}
                    >
                      确认删除
                    </button>
                  ) : (
                    <button type="button" className="btn small ghost" onClick={() => setConfirmId(person.id)}>
                      删除
                    </button>
                  )}
                </div>
                {person.tickets.length > 0 && (
                  <ul>
                    {person.tickets.map((ticket) => (
                      <li key={ticket.id}>
                        <Link to={`/tickets/${ticket.id}`}>
                          <TicketTitle ticketId={ticket.id} title={ticket.title} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
