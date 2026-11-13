import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CrewFace, DeskGate } from '../components/DeskGate'
import { useStaff } from '../context/StaffContext'
import { FACE_PARTS, PRESET_NAMES, PRESETS, presetIndex, sameLook, type FaceLook } from '../lib/faces'
import { missingStaffSetup } from '../lib/staff'

function hint(err: unknown) {
  const message = err instanceof Error ? err.message : '没保存'
  if (missingStaffSetup(message) && /update_my_look|could not find the function/i.test(message)) {
    return '头像还改不了。请在 Supabase SQL Editor 再运行一遍 supabase/staff.sql。'
  }
  return message
}

export function ProfilePage() {
  const { desk, ready, people, saveProfile, saveLook } = useStaff()
  const me = people.find((person) => person.id === desk?.id)
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [look, setLook] = useState<FaceLook>(PRESETS[0])
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const picked = presetIndex(look)

  useEffect(() => {
    if (!desk || !me || loadedId === desk.id) return
    setName(me.display_name)
    setLook(me.look)
    setLoadedId(desk.id)
  }, [desk, me, loadedId])

  async function onSave() {
    if (!desk || !me) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await saveProfile(name.trim(), pin)
      if (!sameLook(look, me.look)) await saveLook(look)
      setPin('')
      setSaved(true)
    } catch (err: unknown) {
      setError(hint(err))
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
        <h1>改资料</h1>
        <Link className="btn small ghost" to={`/tickets/claim/${desk.id}`}>
          自动领取
        </Link>
        <Link className="btn small ghost" to="/tickets">
          返回
        </Link>
      </div>
      <p className="lede">这里改的是当前这位员工自己的名字、密码和小脸。密码留空表示不改。</p>
      <div className="buddy-desk profile-desk">
        <aside className="buddy-side">
          <p className="buddy-kicker">现成的</p>
          <div className="preset-grid" role="radiogroup" aria-label="现成小脸">
            {PRESETS.map((preset, index) => (
              <button
                key={PRESET_NAMES[index]}
                type="button"
                className={picked === index ? 'is-picked' : ''}
                aria-label={PRESET_NAMES[index]}
                onClick={() => {
                  setLook(preset)
                  setSaved(false)
                }}
              >
                <CrewFace look={preset} name={PRESET_NAMES[index]} />
              </button>
            ))}
          </div>
        </aside>
        <div className="buddy-center">
          <form
            className="buddy-card"
            onSubmit={(event) => {
              event.preventDefault()
              void onSave()
            }}
          >
            <div className="buddy-stage">
              <CrewFace look={look} name={name || '友'} large />
              <strong>{name.trim() || '还没起名字'}</strong>
            </div>
            <label>
              名字
              <input value={name} maxLength={20} required onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              新密码
              <input
                type="password"
                value={pin}
                maxLength={20}
                autoComplete="new-password"
                placeholder="留空则不改"
                onChange={(event) => setPin(event.target.value)}
              />
            </label>
            <button type="submit" className="btn buddy-go" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
            {saved && <p className="lede">已保存。</p>}
          </form>
        </div>
        <aside className="buddy-side">
          <p className="buddy-kicker">自己捏</p>
          <div className="pinch">
            {FACE_PARTS.map((part) => (
              <div className="pinch-row" key={part.key}>
                <span>{part.label}</span>
                <div role="radiogroup" aria-label={part.label}>
                  {part.choices.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={look[part.key] === choice.value ? 'is-on' : ''}
                      aria-label={choice.label}
                      onClick={() => {
                        setLook({ ...look, [part.key]: choice.value })
                        setSaved(false)
                      }}
                    >
                      {part.key === 'color' ? <i className={`swatch color-${choice.value}`} /> : choice.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
      {error && <p className="page-status error">{error}</p>}
    </div>
  )
}
