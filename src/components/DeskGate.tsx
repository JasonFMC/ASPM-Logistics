import { useState, type FormEvent } from 'react'
import { useStaff } from '../context/StaffContext'
import { FACE_PARTS, PRESET_NAMES, PRESETS, presetIndex, resolveLook, type FaceLook } from '../lib/faces'

const SHAPES = ['round', 'wide', 'muzzle', 'soft']
const EYES = ['dot', 'closed', 'big', 'wink']
const EARS = ['round', 'long', 'point', 'none']
const MOUTHS = ['smile', 'round', 'wide', 'tooth']
const BACKDROPS = ['plain', 'pad', 'leaf', 'spark']

export function CrewFace({
  hue = 0,
  look,
  name,
  large = false,
  mid = false,
}: {
  hue?: number
  look?: unknown
  name: string
  large?: boolean
  mid?: boolean
}) {
  const face = resolveLook(look, hue)
  return (
    <span
      className={`crew-face color-${face.color} shape-${SHAPES[face.face]} eyes-${EYES[face.eyes]} ears-${EARS[face.ears]} mouth-${MOUTHS[face.mouth]} backdrop-${BACKDROPS[face.backdrop]} ${large ? 'is-hero' : ''} ${mid ? 'is-mid' : ''}`}
      title={name}
      aria-hidden="true"
    >
      <span className="crew-ear is-left" />
      <span className="crew-ear is-right" />
      <span className="crew-stem" />
      <span className="crew-leaf is-left" />
      <span className="crew-leaf is-right" />
      <span className="crew-star" />
      {Array.from({ length: 6 }, (_, index) => (
        <span key={index} className="crew-ray" style={{ transform: `rotate(${index * 60}deg) translateY(-230%)` }} />
      ))}
      <span className={`crew-eye is-left ${face.eyes === 3 ? 'is-wink' : ''}`} />
      <span className="crew-eye is-right" />
      <span className="crew-blush is-left" />
      <span className="crew-blush is-right" />
      <span className="crew-muzzle" />
      <span className="crew-nose" />
      <span className="crew-smile" />
      <span className="crew-mouth" />
      <span className="crew-tooth" />
    </span>
  )
}

export function DeskGate() {
  const { people, register, enter } = useStaff()
  const mine = people.filter((person) => person.mine)
  const [mode, setMode] = useState<'login' | 'join'>('login')
  const [staffId, setStaffId] = useState('')
  const [pin, setPin] = useState('')
  const [name, setName] = useState('')
  const [newPin, setNewPin] = useState('')
  const [look, setLook] = useState<FaceLook>(PRESETS[0])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const picked = presetIndex(look)
  const chosen = mine.find((person) => person.id === staffId) ?? null

  function pickPerson(id: string) {
    setStaffId(id)
    setPin('')
    setError(null)
  }

  async function onEnter(e: FormEvent) {
    e.preventDefault()
    if (!staffId) return
    setBusy(true)
    setError(null)
    try {
      await enter(staffId, pin)
      setPin('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '进不去')
    } finally {
      setBusy(false)
    }
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await register(name.trim(), newPin, look)
      setName('')
      setNewPin('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '建不了')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'join') {
    return (
      <div className="buddy-stack buddy-welcome">
        <button
          type="button"
          className="buddy-back"
          onClick={() => {
            setMode('login')
            setError(null)
          }}
        >
          返回
        </button>
        <div className="buddy-desk">
          <aside className="buddy-side">
            <p className="buddy-kicker">现成的</p>
            <div className="preset-grid" role="radiogroup" aria-label="现成小脸">
              {PRESETS.map((preset, index) => (
                <button
                  key={PRESET_NAMES[index]}
                  type="button"
                  className={picked === index ? 'is-picked' : ''}
                  aria-label={PRESET_NAMES[index]}
                  onClick={() => setLook(preset)}
                >
                  <CrewFace look={preset} name={PRESET_NAMES[index]} />
                </button>
              ))}
            </div>
          </aside>
          <div className="buddy-center">
            <form className="buddy-card" onSubmit={(e) => void onCreate(e)}>
              <p className="buddy-kicker">加入团队</p>
              <div className="buddy-stage">
                <CrewFace look={look} name={name || '友'} large />
                <strong>{name.trim() || '还没起名字'}</strong>
              </div>
              <label>
                小名字
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：小河" required maxLength={20} />
              </label>
              <label>
                密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  placeholder="4 到 20 位，只告诉自己"
                  required
                  minLength={4}
                  maxLength={20}
                />
              </label>
              <button type="submit" className="btn buddy-go" disabled={busy}>
                {busy ? '正在加入…' : '就这个，进池子'}
              </button>
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
                        onClick={() => setLook({ ...look, [part.key]: choice.value })}
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

  return (
    <div className="crew-login">
      <p className="buddy-kicker">登录领取人</p>
      {mine.length === 0 && <p className="crew-empty">这只邮箱还没有领取人</p>}
      <div className="crew-roster">
        {mine.map((person) => (
          <button
            key={person.id}
            type="button"
            className={`roster-person ${staffId === person.id ? 'is-picked' : ''}`}
            onClick={() => pickPerson(person.id)}
          >
            <CrewFace look={person.look} hue={person.hue} name={person.display_name} mid />
            <span>{person.display_name}</span>
          </button>
        ))}
        <button
          type="button"
          className="join-team"
          onClick={() => {
            setMode('join')
            setError(null)
          }}
        >
          <span className="join-mark" aria-hidden="true">
            +
          </span>
          <span>加入团队</span>
        </button>
      </div>
      {chosen && (
        <form className="buddy-card pass-card" onSubmit={(e) => void onEnter(e)}>
          <CrewFace look={chosen.look} hue={chosen.hue} name={chosen.display_name} mid />
          <strong>{chosen.display_name}</strong>
          <label>
            密码
            <input
              type="password"
              autoComplete="current-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              autoFocus
              required
            />
          </label>
          <button type="submit" className="btn buddy-go" disabled={busy}>
            {busy ? '正在进入…' : '进入'}
          </button>
        </form>
      )}
      {error && <p className="page-status error">{error}</p>}
    </div>
  )
}
