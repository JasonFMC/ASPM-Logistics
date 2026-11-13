import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CrewFace, DeskGate } from '../components/DeskGate'
import { useFolders } from '../context/FolderContext'
import { useStaff } from '../context/StaffContext'
import type { TicketFolder } from '../lib/folders'
import { claimSetupHint } from '../lib/staff'

const SLOP = 6

type Zone = 'pool' | 'self'

export function ClaimPage() {
  const { staffId = '' } = useParams()
  const { desk, admin, ready, people } = useStaff()
  const { folders, ready: foldersReady, assignClaim } = useFolders()
  const allowed = Boolean(admin || (desk && desk.id === staffId))
  const person = people.find((row) => row.id === staffId)
  const customers = folders.filter((folder) => folder.kind === 'customer')
  const mine = customers.filter((folder) => folder.claim_staff_id === staffId)
  const [drag, setDrag] = useState<{ id: string; name: string; origin: Zone } | null>(null)
  const [over, setOver] = useState<Zone | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ghostRef = useRef<HTMLDivElement>(null)
  const pointRef = useRef({ x: 0, y: 0 })
  const releaseRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => releaseRef.current?.()
  }, [])

  useLayoutEffect(() => {
    if (!drag) return
    const node = ghostRef.current
    if (!node) return
    document.body.classList.add('is-lifting-ticket')
    node.style.transform = `translate(${pointRef.current.x}px, ${pointRef.current.y}px) translate(-40%, -28%)`
    return () => document.body.classList.remove('is-lifting-ticket')
  }, [drag])

  function ownerName(folder: TicketFolder) {
    if (!folder.claim_staff_id) return ''
    return people.find((row) => row.id === folder.claim_staff_id)?.display_name || '同事'
  }

  function zoneAt(x: number, y: number): Zone | null {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-claim-drop]')?.dataset.claimDrop
    return hit === 'pool' || hit === 'self' ? hit : null
  }

  async function finish(folder: TicketFolder, origin: Zone, zone: Zone | null) {
    const token = desk?.token ?? ''
    if (zone === 'self') {
      if (folder.claim_staff_id === staffId) return
      await assignClaim(folder.id, staffId, token)
      return
    }
    if (zone === 'pool' && origin === 'self' && folder.claim_staff_id === staffId) {
      await assignClaim(folder.id, null, token)
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLElement>, folder: TicketFolder, origin: Zone) {
    if (!allowed || event.button !== 0 || busy) return
    const pointerId = event.pointerId
    const startX = event.clientX
    const startY = event.clientY
    let lifted = false

    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return
      pointRef.current = { x: moveEvent.clientX, y: moveEvent.clientY }
      if (!lifted) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < SLOP) return
        lifted = true
        setDrag({ id: folder.id, name: folder.name, origin })
      }
      const zone = zoneAt(moveEvent.clientX, moveEvent.clientY)
      setOver(zone)
      const node = ghostRef.current
      if (node) node.style.transform = `translate(${moveEvent.clientX}px, ${moveEvent.clientY}px) translate(-40%, -28%)`
    }

    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return
      release()
      if (!lifted) return
      const zone = zoneAt(upEvent.clientX, upEvent.clientY)
      setDrag(null)
      setOver(null)
      setBusy(true)
      setError(null)
      void finish(folder, origin, zone)
        .catch((err: unknown) => setError(claimSetupHint(err)))
        .finally(() => setBusy(false))
    }

    const release = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      releaseRef.current = null
    }

    releaseRef.current = release
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  if (!ready || !foldersReady) return <p className="page-status">加载中…</p>
  if (!admin && !desk) {
    return (
      <div className="buddy-page">
        <DeskGate />
      </div>
    )
  }
  if (!allowed) return <p className="page-status error">只能改自己的自动领取</p>

  return (
    <div className="module-page">
      <div className="ticket-head">
        <h1>自动领取{person ? ` · ${person.display_name}` : ''}</h1>
        <Link className="btn small ghost" to="/tickets">
          返回
        </Link>
      </div>
      <p className="folder-note">
        左边是已经建立的客户。把客户拖进右侧，对得上且还没人领的任务会记到这位同事身上，并只从「未分配」拿掉。再从右侧拖回左边，就取消。已经有人领的单不会被改走。亲手放回的单，不会再被这个人自动领回去。
      </p>
      {error && <p className="page-status error">{error}</p>}
      <div className="claim-board">
        <section className={`claim-pool${over === 'pool' ? ' is-over' : ''}`} data-claim-drop="pool" aria-label="客户名称">
          <h2>客户名称</h2>
          {customers.length === 0 && <p className="lede">还没有客户。先在左侧「客户名称」里新建。</p>}
          <ul>
            {customers.map((folder) => {
              const owner = ownerName(folder)
              return (
                <li
                  key={folder.id}
                  className={`claim-customer${drag?.id === folder.id ? ' is-source' : ''}`}
                  onPointerDown={(event) => onPointerDown(event, folder, 'pool')}
                >
                  <strong>{folder.name}</strong>
                  {owner && <span className="claim-tag">{owner}</span>}
                </li>
              )
            })}
          </ul>
        </section>
        <section className={`claim-self${over === 'self' ? ' is-over' : ''}`} data-claim-drop="self" aria-label="领给这位同事">
          <header>
            {person && <CrewFace look={person.look} hue={person.hue} name={person.display_name} />}
            <strong>{person?.display_name ?? '这位同事'}</strong>
          </header>
          <p className="folder-note">拖到这里</p>
          {mine.length === 0 && <p className="lede">还没有领到客户。</p>}
          <ul>
            {mine.map((folder) => (
              <li
                key={folder.id}
                className={`claim-customer${drag?.id === folder.id ? ' is-source' : ''}`}
                onPointerDown={(event) => onPointerDown(event, folder, 'self')}
              >
                <strong>{folder.name}</strong>
                <span className="claim-tag">{person?.display_name ?? '同事'}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {drag && (
        <div ref={ghostRef} className="drag-ghost" aria-hidden="true">
          <strong>{drag.name}</strong>
          <span className="pond-meta">
            {over === 'self' ? '松手领给这位同事' : over === 'pool' && drag.origin === 'self' ? '松手放回客户池' : '拖到右侧'}
          </span>
        </div>
      )}
    </div>
  )
}
