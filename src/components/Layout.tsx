import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useStaff } from '../context/StaffContext'
import { YardOpsContext } from '../context/YardOpsContext'
import { MapPage } from '../pages/MapPage'
import { platformModules } from '../platform/modules'

export function Layout() {
  const { user, signOut } = useAuth()
  const { desk, leave, admin, saveProfile } = useStaff()
  const { pathname } = useLocation()
  const onYardMap = pathname === '/yard' || pathname === '/yard/manage' || pathname === '/yard/search'
  const onTickets = pathname === '/tickets' || pathname.startsWith('/tickets/')
  const [opsNode, setOpsNode] = useState<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [profilePin, setProfilePin] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  useEffect(() => {
    setProfileName(desk?.display_name ?? '')
    setProfilePin('')
    setProfileError(null)
    if (!desk) setProfileOpen(false)
  }, [desk])

  useEffect(() => {
    return () => {
      if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    }
  }, [])

  function openMenu() {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    setMenuOpen(true)
  }

  function scheduleClose() {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setMenuOpen(false), 900)
  }

  return (
    <YardOpsContext.Provider value={opsNode}>
      <div className={`app-shell ${onYardMap || onTickets ? 'has-dock' : ''} ${onYardMap ? 'map-bleed' : ''}`}>
        <header
          className={`topbar ${menuOpen ? 'menu-open' : ''}`}
          onMouseEnter={() => {
            if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
          }}
          onMouseLeave={scheduleClose}
        >
          <div className="brand-menu" onMouseEnter={openMenu}>
            <NavLink
              to="/"
              className="brand"
              end
              aria-expanded={menuOpen}
              onClick={(event) => {
                if (!menuOpen) {
                  event.preventDefault()
                  openMenu()
                }
              }}
            >
              ASPM Workshop
            </NavLink>
          </div>
          <nav className="module-nav" aria-label="板块" onMouseEnter={openMenu}>
            {platformModules.map((mod) => (
              <NavLink key={mod.id} to={mod.path} onClick={() => setMenuOpen(false)}>
                {mod.name}
              </NavLink>
            ))}
          </nav>
          <div className="topbar-meta">
            <span className="user-email">{desk ? desk.display_name : user?.email}</span>
            {desk && (
              <button type="button" className="btn ghost" onClick={() => setProfileOpen((open) => !open)}>
                改资料
              </button>
            )}
            {desk && profileOpen && (
              <form
                className="desk-editor"
                onSubmit={(event) => {
                  event.preventDefault()
                  setProfileBusy(true)
                  setProfileError(null)
                  void saveProfile(profileName.trim(), profilePin)
                    .then(() => {
                      setProfilePin('')
                      setProfileOpen(false)
                    })
                    .catch((err: unknown) => {
                      setProfileError(err instanceof Error ? err.message : '没保存')
                    })
                    .finally(() => setProfileBusy(false))
                }}
              >
                <label>
                  名字
                  <input value={profileName} maxLength={20} required onChange={(event) => setProfileName(event.target.value)} />
                </label>
                <label>
                  新密码
                  <input
                    type="password"
                    value={profilePin}
                    maxLength={20}
                    autoComplete="new-password"
                    placeholder="留空则不改"
                    onChange={(event) => setProfilePin(event.target.value)}
                  />
                </label>
                {profileError && <p>{profileError}</p>}
                <button type="submit" className="btn small" disabled={profileBusy}>
                  {profileBusy ? '保存中…' : '保存'}
                </button>
              </form>
            )}
            {desk && (
              <button type="button" className="btn desk-id" onClick={leave}>
                员工身份
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => void signOut()}>
              退出
            </button>
          </div>
        </header>

        <main className="main">
          <div className="yard-slot" hidden={!onYardMap}>
            <MapPage manageRoute={pathname === '/yard/manage'} searchRoute={pathname === '/yard/search'} />
          </div>
          {!onYardMap && <Outlet />}
        </main>

        {(onYardMap || onTickets) && (
          <footer className="ops-bar dock">
            {onYardMap && <div className="yard-ops" ref={setOpsNode} />}
            {onYardMap ? (
              <nav className="tabbar">
                <NavLink to="/yard/search">查找</NavLink>
                <NavLink to="/yard/manage">管理</NavLink>
                <NavLink to="/yard" end>
                  区域绘制
                </NavLink>
              </nav>
            ) : (
              <nav className="tabbar">
                <NavLink to="/tickets" end>
                  池子
                </NavLink>
                <NavLink to="/tickets/due">待办</NavLink>
                <NavLink to="/tickets/new">新建</NavLink>
                {admin && <NavLink to="/tickets/staff">员工</NavLink>}
              </nav>
            )}
          </footer>
        )}
      </div>
    </YardOpsContext.Provider>
  )
}
