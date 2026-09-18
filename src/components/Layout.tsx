import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function Layout() {
  const { user, signOut } = useAuth()

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">ASPM YARD</div>
        <div className="topbar-meta">
          <span className="user-email">{user?.email}</span>
          <button type="button" className="btn ghost" onClick={() => void signOut()}>
            退出
          </button>
        </div>
      </header>

      <main className="main">
        <Outlet />
      </main>

      <nav className="tabbar">
        <NavLink to="/" end>
          地图
        </NavLink>
        <NavLink to="/search">搜索</NavLink>
        <NavLink to="/admin">管理</NavLink>
      </nav>
    </div>
  )
}
