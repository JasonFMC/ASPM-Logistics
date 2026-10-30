import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from './AuthContext'
import {
  createStaff,
  enterDesk,
  listStaff,
  loadDeskAdmin,
  updateMyStaff,
  type DeskPass,
  type StaffCard,
} from '../lib/staff'
import type { FaceLook } from '../lib/faces'

const STORAGE_KEY = 'aspm-desk'

interface StaffState {
  people: StaffCard[]
  admin: boolean
  desk: DeskPass | null
  ready: boolean
  refresh: () => Promise<void>
  register: (name: string, pin: string, look: FaceLook) => Promise<void>
  enter: (staffId: string, pin: string) => Promise<void>
  saveProfile: (name: string, pin: string) => Promise<void>
  leave: () => void
}

const StaffContext = createContext<StaffState | null>(null)

function readDesk(): DeskPass | null {
  const raw = sessionStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeskPass
    if (!parsed.token || !parsed.id) return null
    return parsed
  } catch {
    return null
  }
}

export function StaffProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [people, setPeople] = useState<StaffCard[]>([])
  const [admin, setAdmin] = useState(false)
  const [desk, setDesk] = useState<DeskPass | null>(() => readDesk())
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    const [rows, isAdmin] = await Promise.all([listStaff(), loadDeskAdmin()])
    setPeople(rows)
    setAdmin(isAdmin)
  }, [])

  useEffect(() => {
    if (!user) {
      sessionStorage.removeItem(STORAGE_KEY)
      setPeople([])
      setAdmin(false)
      setDesk(null)
      setReady(true)
      return
    }
    setDesk(readDesk())
    let cancelled = false
    void refresh()
      .catch(() => {
        if (!cancelled) setPeople([])
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [user, refresh])

  const remember = useCallback((pass: DeskPass) => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pass))
    setDesk(pass)
  }, [])

  const register = useCallback(
    async (name: string, pin: string, look: FaceLook) => {
      const created = await createStaff(name, pin, look)
      await refresh()
      remember(await enterDesk(created.id, pin))
    },
    [refresh, remember],
  )

  const enter = useCallback(
    async (staffId: string, pin: string) => {
      remember(await enterDesk(staffId, pin))
    },
    [remember],
  )

  const leave = useCallback(() => {
    sessionStorage.removeItem(STORAGE_KEY)
    setDesk(null)
  }, [])

  const saveProfile = useCallback(
    async (name: string, pin: string) => {
      if (!desk) throw new Error('请先进入员工身份')
      const nextName = await updateMyStaff(desk.token, name, pin)
      remember({ ...desk, display_name: nextName })
      await refresh()
    },
    [desk, remember, refresh],
  )

  const value = useMemo(
    () => ({ people, admin, desk, ready, refresh, register, enter, saveProfile, leave }),
    [people, admin, desk, ready, refresh, register, enter, saveProfile, leave],
  )

  return <StaffContext.Provider value={value}>{children}</StaffContext.Provider>
}

export function useStaff() {
  const ctx = useContext(StaffContext)
  if (!ctx) throw new Error('useStaff must be used within StaffProvider')
  return ctx
}
