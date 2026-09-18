import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { AuthProvider, useAuth } from './context/AuthContext'
import { isSupabaseConfigured } from './lib/supabase'
import { AdminPage } from './pages/AdminPage'
import { ItemPage } from './pages/ItemPage'
import { LoginPage } from './pages/LoginPage'
import { MapPage } from './pages/MapPage'
import { SearchPage } from './pages/SearchPage'
import { SetupPage } from './pages/SetupPage'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />
  if (loading) return <p className="page-status">加载中…</p>
  if (!user) return <Navigate to="/login" replace />
  return children
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/"
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route index element={<MapPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="admin" element={<AdminPage />} />
            <Route path="item/:id" element={<ItemPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
