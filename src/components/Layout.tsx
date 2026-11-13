import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { FolderProvider } from '../context/FolderContext'
import { MailSyncProvider } from '../context/MailSyncContext'
import { useStaff } from '../context/StaffContext'
import { YardOpsContext } from '../context/YardOpsContext'
import { MapPage } from '../pages/MapPage'
import { platformModules } from '../platform/modules'
import { TaskFolders } from './TaskFolders'

export function Layout() {
  return (
    <FolderProvider>
      <MailSyncProvider>
        <DeskShell />
      </MailSyncProvider>
    </FolderProvider>
  )
}

function DeskShell() {
  const { user, signOut } = useAuth()
  const { desk, leave, admin } = useStaff()
  const { pathname } = useLocation()
  const onYardMap = pathname === '/yard' || pathname === '/yard/manage' || pathname === '/yard/search'
  const onTickets = pathname === '/tickets' || pathname.startsWith('/tickets/')
  const [opsNode, setOpsNode] = useState<HTMLDivElement | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

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
        </header>

        <TaskFolders />

        <main className="main">
          <div className="main-slot">
            <div className="yard-slot" hidden={!onYardMap}>
              <MapPage manageRoute={pathname === '/yard/manage'} searchRoute={pathname === '/yard/search'} />
            </div>
            {!onYardMap && <Outlet />}
          </div>
        </main>

        <aside className="side-rail">
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
                    任务池
                  </NavLink>
                  <NavLink to="/tickets/search">搜索</NavLink>
                  <NavLink to="/tickets/due">提醒</NavLink>
                  <NavLink to="/tickets/new">新建</NavLink>
                  {admin && <NavLink to="/tickets/staff">员工</NavLink>}
                </nav>
              )}
            </footer>
          )}
          <div className="staff-corner">
            <span className="user-email">{desk ? desk.display_name : user?.email}</span>
            {desk && (
              <NavLink to="/tickets/profile" className="btn ghost">
                改资料
              </NavLink>
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
        </aside>
      </div>
    </YardOpsContext.Provider>
  )
}
