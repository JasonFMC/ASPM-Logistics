import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useFolders } from './FolderContext'
import { applyAllFolders, folderSetupHint } from '../lib/folders'
import { applyAutoClaims, claimSetupHint } from '../lib/staff'
import { clearMailCache } from '../lib/mailLetter'
import { pullMail, type PullProgress, type PullResult } from '../lib/tickets'

const WAIT_MS = 60_000

interface MailSyncState {
  generation: number
  running: boolean
  status: string
  pct: number
  failed: boolean
  syncNow: () => void
}

const MailSyncContext = createContext<MailSyncState | null>(null)

function userIsBusy() {
  if (document.body.classList.contains('is-lifting-ticket')) return true
  const el = document.activeElement
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el instanceof HTMLElement && el.isContentEditable)
}

function sydneyWhen(iso: string) {
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Sydney',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(time))
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}月${pick('day')}日 ${pick('hour')}:${pick('minute')}`
}

function summary(result: PullResult) {
  const inserted = result.inserted ?? 0
  const updated = result.updated ?? 0
  const archived = result.archived ?? 0
  const threaded = result.threaded ?? 0
  const pending = result.pending ?? 0
  const parts = []
  if (inserted) parts.push(`新来 ${inserted} 张`)
  if (threaded) parts.push(`并入 ${threaded} 封`)
  if (updated) parts.push(`标题更新 ${updated} 张`)
  if (archived) parts.push(`留档 ${archived} 张`)
  if (pending > 0) parts.push(result.oldest ? `还有新信，最早一封是 ${sydneyWhen(result.oldest)}，下一分钟继续` : '还有新信，下一分钟继续')
  return parts.length ? parts.join('，') : '已对齐'
}

export function MailSyncProvider({ children }: { children: ReactNode }) {
  const { refreshMemberships } = useFolders()
  const [generation, setGeneration] = useState(0)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('即将对齐')
  const [pct, setPct] = useState(0)
  const [failed, setFailed] = useState(false)
  const runningRef = useRef(false)
  const pendingRef = useRef(false)
  const stoppedRef = useRef(false)
  const lastStartedRef = useRef(0)
  const runRef = useRef<(manual?: boolean) => Promise<void>>(async () => undefined)

  useEffect(() => {
    stoppedRef.current = false

    async function flush() {
      if (stoppedRef.current || !pendingRef.current || userIsBusy()) return
      pendingRef.current = false
      try {
        await refreshMemberships()
      } catch {
        // 归类表还没建好时，工单列表仍可以刷新
      }
      if (!stoppedRef.current) setGeneration((value) => value + 1)
    }

    async function run(manual = false) {
      if (stoppedRef.current || runningRef.current) return
      if (!manual && document.hidden) return
      runningRef.current = true
      lastStartedRef.current = Date.now()
      setRunning(true)
      setFailed(false)
      setPct(0)
      setStatus('正在对齐')
      const onProgress = (update: PullProgress) => {
        if (stoppedRef.current) return
        setPct(update.pct)
        setStatus(update.step)
      }
      try {
        const result = await pullMail(onProgress)
        if ((result.updated ?? 0) > 0) clearMailCache()
        const problems: string[] = []
        try {
          await applyAllFolders()
        } catch (err) {
          problems.push(folderSetupHint(err))
        }
        try {
          await applyAutoClaims()
        } catch (err) {
          problems.push(claimSetupHint(err))
        }
        if (!stoppedRef.current) {
          setPct(100)
          if (problems.length) {
            setFailed(true)
            setStatus(`${summary(result)}。${problems[0]}`)
          } else {
            setStatus(summary(result))
          }
        }
        pendingRef.current = true
        await flush()
      } catch (err: unknown) {
        if (!stoppedRef.current) {
          const message = err instanceof Error ? err.message : '没能和邮箱对齐'
          setFailed(true)
          setStatus(message.length > 36 ? `${message.slice(0, 36)}…` : message)
        }
      } finally {
        runningRef.current = false
        if (!stoppedRef.current) setRunning(false)
      }
    }

    runRef.current = run

    const started = window.setTimeout(() => void runRef.current(false), 4000)
    const interval = window.setInterval(() => void runRef.current(false), WAIT_MS)
    const onShow = () => {
      if (!document.hidden && Date.now() - lastStartedRef.current >= WAIT_MS) void runRef.current(false)
    }
    const onIdle = (event: Event) => {
      if (event.type === 'focusout') {
        const next = (event as FocusEvent).relatedTarget
        if (
          next instanceof HTMLInputElement ||
          next instanceof HTMLTextAreaElement ||
          next instanceof HTMLSelectElement ||
          (next instanceof HTMLElement && next.isContentEditable)
        ) {
          return
        }
      }
      void flush()
    }
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('pointerup', onIdle)
    window.addEventListener('focusout', onIdle)
    const poll = window.setInterval(() => void flush(), 1000)

    return () => {
      stoppedRef.current = true
      window.clearTimeout(started)
      window.clearInterval(interval)
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('pointerup', onIdle)
      window.removeEventListener('focusout', onIdle)
    }
  }, [refreshMemberships])

  const syncNow = () => void runRef.current(true)
  const value = useMemo(
    () => ({ generation, running, status, pct, failed, syncNow }),
    [generation, running, status, pct, failed],
  )
  return <MailSyncContext.Provider value={value}>{children}</MailSyncContext.Provider>
}

export function useMailSync() {
  const value = useContext(MailSyncContext)
  if (!value) throw new Error('useMailSync')
  return value
}
