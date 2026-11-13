import { useMemo, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useFolders } from '../context/FolderContext'
import { useStaff } from '../context/StaffContext'
import type { FolderKind } from '../lib/folders'

const COLUMNS: Array<{ kind: FolderKind; title: string; placeholder: string }> = [
  { kind: 'customer', title: '客户名称', placeholder: '客户名称' },
  { kind: 'document', title: '文档整理', placeholder: '文档名称' },
]

export function TaskFolders() {
  const { desk } = useStaff()
  const { folders, memberships, add, error } = useFolders()
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of memberships) {
      if (item.status === 'done') continue
      map.set(item.folder_id, (map.get(item.folder_id) ?? 0) + 1)
    }
    return map
  }, [memberships])
  const navigate = useNavigate()
  const [creating, setCreating] = useState<FolderKind | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  async function onCreate(kind: FolderKind) {
    const name = newName.trim()
    if (!name || !desk) return
    setBusy(true)
    try {
      const folder = await add(name, desk.id, kind)
      setNewName('')
      setCreating(null)
      navigate(`/tickets/folder/${folder.id}`)
    } catch {
      /* 错误显示在栏里 */
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="folder-rail">
      <div className="folder-columns">
        {COLUMNS.map((column) => (
          <section key={column.kind} className="folder-column" aria-label={column.title}>
            <div className="folder-rail-head">
              <h2>{column.title}</h2>
              {desk && (
                <button
                  type="button"
                  className="btn small"
                  onClick={() => {
                    setCreating((open) => (open === column.kind ? null : column.kind))
                    setNewName('')
                  }}
                >
                  新建
                </button>
              )}
            </div>
            {creating === column.kind && desk && (
              <form
                className="folder-create"
                onSubmit={(event) => {
                  event.preventDefault()
                  void onCreate(column.kind)
                }}
              >
                <input
                  value={newName}
                  maxLength={40}
                  required
                  placeholder={column.placeholder}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <button type="submit" className="btn small" disabled={busy}>
                  建立
                </button>
              </form>
            )}
            <ul className="folder-list">
              {folders
                .filter((folder) => folder.kind === column.kind)
                .map((folder) => (
                  <li key={folder.id}>
                    <NavLink to={`/tickets/folder/${folder.id}`} data-folder-id={folder.id}>
                      <span className="folder-name">{folder.name}</span>
                      <span className="folder-count">{counts.get(folder.id) ?? 0}</span>
                    </NavLink>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      {!desk && <p className="folder-note">先在工单页选自己的头像并输入密码，然后可以建立和修改。</p>}
      {error && <p className="folder-error">{error}</p>}
    </aside>
  )
}
