import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RuleLines, linesFromText, textFromLines } from '../components/RuleLines'
import { useFolders } from '../context/FolderContext'
import { folderSetupHint } from '../lib/folders'

const EMPTY = { name: '', senders: '', show_unassigned: true }

export function FolderPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { folders, ready, save, remove, collect } = useFolders()
  const folder = folders.find((row) => row.id === id)
  const [draft, setDraft] = useState(EMPTY)
  const [senders, setSenders] = useState<string[]>([''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [senderSaved, setSenderSaved] = useState(false)

  useEffect(() => {
    if (!folder) return
    setDraft({
      name: folder.name,
      senders: folder.senders,
      show_unassigned: folder.show_unassigned,
    })
    setSenders(linesFromText(folder.senders))
    setError(null)
  }, [folder])

  async function persist(leave: boolean) {
    if (!folder || !draft.name.trim()) {
      setError(customer ? '请先填写客户名称' : '请先填写名称')
      return
    }
    const next = { ...draft, name: draft.name.trim(), senders: textFromLines(senders), titles: '' }
    setBusy(true)
    setError(null)
    setSenderSaved(false)
    try {
      await save(id, next)
      await collect({ ...folder, ...next })
      if (leave) navigate(`/tickets/folder/${id}`)
      else setSenderSaved(true)
    } catch (err: unknown) {
      setError(folderSetupHint(err))
    } finally {
      setBusy(false)
    }
  }

  async function onRemove() {
    setBusy(true)
    setError(null)
    try {
      await remove(id)
      navigate('/tickets')
    } catch (err: unknown) {
      setError(folderSetupHint(err))
      setBusy(false)
    }
  }

  if (!ready) return <p className="page-status">加载中…</p>
  if (!folder) return <p className="page-status error">没有这个文件夹</p>
  const customer = folder.kind === 'customer'

  return (
      <div className="module-page">
        <div className="ticket-head">
          <h1>{customer ? '编辑客户名称' : '编辑文档整理'}</h1>
        </div>
        <form
          className="folder-editor"
          onSubmit={(event) => {
            event.preventDefault()
            void persist(true)
          }}
        >
          <label>
            {customer ? '客户名称' : '名称'}
            <input
              value={draft.name}
              maxLength={40}
              required
              onChange={(event) => setDraft((row) => ({ ...row, name: event.target.value }))}
            />
          </label>
          <button
            type="button"
            className={`folder-tick ${draft.show_unassigned ? '' : 'is-on'}`}
            aria-pressed={!draft.show_unassigned}
            onClick={() => setDraft((row) => ({ ...row, show_unassigned: !row.show_unassigned }))}
          >
            <span className="folder-tick-box" aria-hidden="true">{draft.show_unassigned ? '' : '✓'}</span>
            不在未分配任务池中显示
          </button>
          <p className="folder-note">勾选后，收进这里的任务不再出现在未分配里。打开这里仍能看到。不勾选时，这些任务仍留在未分配里。</p>
          <fieldset className="folder-rules">
            <legend>自动收录设置</legend>
            <RuleLines
              label="发件人"
              hint={customer ? '每次填一个邮箱或域名，点加号再加一条。左侧减号删掉这一条，然后点保存。' : '每次填一个邮箱或域名，点加号再加一条'}
              values={senders}
              onChange={(rows) => {
                setSenderSaved(false)
                setSenders(rows)
              }}
              minus={customer}
              saving={busy}
              saved={customer && senderSaved}
              onSave={customer ? () => void persist(false) : undefined}
            />
            <p className="folder-note">保存后，这些地址的来往都会收进这个文件夹：对方发来的，以及我们发给这个地址的。不用另填收件人。地址空着时，不会自动收录。拖进来的任务会一直留着。</p>
          </fieldset>
          {error && <p className="folder-error">{error}</p>}
          <div className="folder-actions">
            <button type="submit" className="btn small" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => navigate(`/tickets/folder/${id}`)}>
              取消
            </button>
          </div>
          <button type="button" className="btn small ghost folder-delete" disabled={busy} onClick={() => void onRemove()}>
            {customer ? '删除这个客户' : '删除这个文档整理'}
          </button>
        </form>
      </div>
    )
}
