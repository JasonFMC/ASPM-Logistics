import type { MailFile } from './mailLetter'
import { supabase } from './supabase'

export interface TicketMessage {
  id: string
  ticket_id: string
  from_name: string | null
  from_email: string | null
  subject: string | null
  received_at: string | null
  body: string | null
  attachments: MailFile[]
}

function asFile(value: unknown, index: number): MailFile | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { index?: unknown; name?: unknown; size?: unknown; type?: unknown }
  const name = typeof row.name === 'string' ? row.name : ''
  if (!name) return null
  return {
    index: typeof row.index === 'number' ? row.index : index,
    name,
    size: typeof row.size === 'number' ? row.size : 0,
    type: typeof row.type === 'string' ? row.type : 'application/octet-stream',
  }
}

/** 表还没建时返回 null，页面仍按单封信显示。 */
export async function listTicketMessages(ticketId: string) {
  const { data, error } = await supabase
    .from('ticket_messages')
    .select('id, ticket_id, from_name, from_email, subject, received_at, body, attachments')
    .eq('ticket_id', ticketId)
    .or('message_id.is.null,message_id.not.like.seen:%')
    .order('received_at', { ascending: true })
  if (error) {
    if (/ticket_messages|schema cache/i.test(error.message)) return null
    throw error
  }
  return (data ?? []).map((row) => ({
    id: String(row.id),
    ticket_id: String(row.ticket_id),
    from_name: typeof row.from_name === 'string' ? row.from_name : null,
    from_email: typeof row.from_email === 'string' ? row.from_email : null,
    subject: typeof row.subject === 'string' ? row.subject : null,
    received_at: typeof row.received_at === 'string' ? row.received_at : null,
    body: typeof row.body === 'string' ? row.body : null,
    attachments: Array.isArray(row.attachments)
      ? row.attachments.map(asFile).filter((file): file is MailFile => Boolean(file))
      : [],
  })) satisfies TicketMessage[]
}
