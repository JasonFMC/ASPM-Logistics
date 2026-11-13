import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { applyAutoClaims, assignClaimFolder, claimSetupHint } from '../lib/staff'
import {
  applyAllFolders,
  applyFolder,
  createFolder,
  folderSetupHint,
  listFolders,
  listMemberships,
  placeInFolder,
  removeFolder,
  removeFromFolder,
  saveFolder,
  type FolderKind,
  type FolderMembership,
  type TicketFolder,
} from '../lib/folders'

interface FolderUi {
  folders: TicketFolder[]
  memberships: FolderMembership[]
  namesByTicket: Map<string, Array<{ name: string; kind: FolderKind }>>
  ready: boolean
  error: string | null
  add: (name: string, staffId: string, kind: FolderKind) => Promise<TicketFolder>
  save: (id: string, patch: Pick<TicketFolder, 'name' | 'senders' | 'titles' | 'show_unassigned'>) => Promise<void>
  remove: (id: string) => Promise<void>
  assignClaim: (folderId: string, staffId: string | null, token: string) => Promise<void>
  place: (folderId: string, ticketId: string) => Promise<void>
  takeOut: (folderId: string, ticketId: string) => Promise<void>
  collect: (folder: TicketFolder) => Promise<void>
  collectAll: () => Promise<void>
  refreshMemberships: () => Promise<void>
}

const FolderContext = createContext<FolderUi | null>(null)

export function FolderProvider({ children }: { children: ReactNode }) {
  const [folders, setFolders] = useState<TicketFolder[]>([])
  const [memberships, setMemberships] = useState<FolderMembership[]>([])
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshMemberships = useCallback(async () => {
    setMemberships(await listMemberships())
  }, [])

  useEffect(() => {
    let cancelled = false
    void listFolders()
      .then(async (rows) => {
        if (cancelled) return
        setFolders(rows)
        try {
          const items = await listMemberships()
          if (!cancelled) setMemberships(items)
        } catch (err: unknown) {
          if (!cancelled) setError(folderSetupHint(err))
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(folderSetupHint(err))
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const add = useCallback(async (name: string, staffId: string, kind: FolderKind) => {
    setError(null)
    try {
      const folder = await createFolder(name, staffId, kind)
      setFolders((rows) => [...rows, folder])
      return folder
    } catch (err: unknown) {
      setError(folderSetupHint(err))
      throw err
    }
  }, [])

  const save = useCallback(async (id: string, patch: Pick<TicketFolder, 'name' | 'senders' | 'titles' | 'show_unassigned'>) => {
    const next = { ...patch, name: patch.name.trim() }
    await saveFolder(id, next)
    setFolders((rows) => rows.map((row) => (row.id === id ? { ...row, ...next } : row)))
  }, [])

  const remove = useCallback(async (id: string) => {
    const current = folders.find((row) => row.id === id)
    await removeFolder(id)
    setFolders((rows) => rows.filter((row) => row.id !== id))
    setMemberships((rows) => rows.filter((row) => row.folder_id !== id))
    if (current?.kind === 'customer') {
      try {
        await applyAutoClaims()
      } catch {
        /* 客户删掉后，自动领取下一轮邮件对齐时再放回 */
      }
    }
  }, [folders])

  const assignClaim = useCallback(async (folderId: string, staffId: string | null, token: string) => {
    const current = folders.find((row) => row.id === folderId)
    if (current) {
      try {
        await applyFolder(current)
      } catch (err: unknown) {
        throw new Error(folderSetupHint(err))
      }
    }
    await assignClaimFolder(folderId, staffId, token)
    setFolders((rows) => rows.map((row) => (row.id === folderId ? { ...row, claim_staff_id: staffId } : row)))
    await refreshMemberships()
  }, [folders, refreshMemberships])

  const place = useCallback(
    async (folderId: string, ticketId: string) => {
      await placeInFolder(folderId, ticketId)
      await refreshMemberships()
    },
    [refreshMemberships],
  )

  const takeOut = useCallback(
    async (folderId: string, ticketId: string) => {
      await removeFromFolder(folderId, ticketId)
      setMemberships((rows) => rows.filter((row) => row.folder_id !== folderId || row.ticket_id !== ticketId))
    },
    [],
  )

    const collect = useCallback(
    async (folder: TicketFolder) => {
      await applyFolder(folder)
      await refreshMemberships()
      if (folder.kind === 'customer') {
        try {
          await applyAutoClaims()
        } catch (err) {
          throw new Error(claimSetupHint(err))
        }
      }
    },
    [refreshMemberships],
  )

  const collectAll = useCallback(async () => {
    await applyAllFolders()
    await refreshMemberships()
  }, [refreshMemberships])

  const namesByTicket = useMemo(() => {
    const byFolder = new Map(folders.map((folder) => [folder.id, folder]))
    const map = new Map<string, Array<{ name: string; kind: FolderKind }>>()
    for (const item of memberships) {
      const folder = byFolder.get(item.folder_id)
      if (!folder) continue
      const names = map.get(item.ticket_id) ?? []
      names.push({ name: folder.name, kind: folder.kind })
      map.set(item.ticket_id, names)
    }
    return map
  }, [folders, memberships])

  const value = useMemo(
    () => ({
      folders,
      memberships,
      namesByTicket,
      ready,
      error,
      add,
      save,
      remove,
      assignClaim,
      place,
      takeOut,
      collect,
      collectAll,
      refreshMemberships,
    }),
    [folders, memberships, namesByTicket, ready, error, add, save, remove, assignClaim, place, takeOut, collect, collectAll, refreshMemberships],
  )

  return <FolderContext.Provider value={value}>{children}</FolderContext.Provider>
}

export function useFolders() {
  const value = useContext(FolderContext)
  if (!value) throw new Error('useFolders')
  return value
}
