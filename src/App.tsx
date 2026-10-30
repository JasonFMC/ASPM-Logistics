import { HashRouter, Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom'
import { Layout } from './components/Layout'
import { AuthProvider, useAuth } from './context/AuthContext'
import { StaffProvider } from './context/StaffContext'
import { isSupabaseConfigured } from './lib/supabase'
import { HomePage } from './pages/HomePage'
import { ItemPage } from './pages/ItemPage'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'
import { TicketDetailPage, TicketNewPage, TicketsDuePage, TicketsListPage } from './pages/TicketsPage'
import { StaffAdminPage } from './pages/StaffAdminPage'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (!isSupabaseConfigured) return <Navigate to="/setup" replace />
  if (loading) return <p className="page-status">加载中…</p>
  if (!user) return <Navigate to="/login" replace />
  return children
}

function LegacyItemRedirect() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const query = params.toString()
  return <Navigate to={`/yard/item/${id ?? ''}${query ? `?${query}` : ''}`} replace />
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
                <StaffProvider>
                  <Layout />
                </StaffProvider>
              </Protected>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="yard" element={null} />
            <Route path="yard/manage" element={null} />
            <Route path="yard/search" element={null} />
            <Route path="yard/item/:id" element={<ItemPage />} />
            <Route path="tickets" element={<TicketsListPage />} />
            <Route path="tickets/new" element={<TicketNewPage />} />
            <Route path="tickets/due" element={<TicketsDuePage />} />
            <Route path="tickets/staff" element={<StaffAdminPage />} />
            <Route path="tickets/:id" element={<TicketDetailPage />} />
            <Route path="manage" element={<Navigate to="/yard/manage" replace />} />
            <Route path="search" element={<Navigate to="/yard/search" replace />} />
            <Route path="admin" element={<Navigate to="/yard/manage" replace />} />
            <Route path="item/:id" element={<LegacyItemRedirect />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  )
}
