import { WAITING_REASON_LABEL, WORK_STEPS, workStep } from '../lib/tickets'
import type { TicketStatus, WaitingReason } from '../lib/types'

export function TicketStepBar({
  status,
  claimedBy,
  waitingReason,
  compact = false,
}: {
  status: TicketStatus
  claimedBy?: string | null
  waitingReason?: WaitingReason | null
  compact?: boolean
}) {
  const step = workStep({ status, claimed_by: claimedBy })
  if (step === 'cancelled') {
    return <p className={`ticket-cancelled${compact ? ' is-compact' : ''}`}>已取消</p>
  }
  const index = WORK_STEPS.findIndex((item) => item.id === step)
  return (
    <ol className={`ticket-progress${compact ? ' is-compact' : ''}`} aria-label="当前步骤">
      {WORK_STEPS.map((item, itemIndex) => {
        const current = itemIndex === index
        const label =
          current && item.id === 'waiting' && waitingReason ? WAITING_REASON_LABEL[waitingReason] : item.label
        return (
          <li
            key={item.id}
            className={current ? `is-current step-${item.id}` : itemIndex < index ? 'is-done' : undefined}
            aria-current={current ? 'step' : undefined}
          >
            {label}
          </li>
        )
      })}
    </ol>
  )
}
