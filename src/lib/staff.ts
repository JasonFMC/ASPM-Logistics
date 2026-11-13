import { resolveLook, type FaceLook } from './faces'
import { supabase } from './supabase'

export interface StaffCard {
  id: string
  display_name: string
  hue: number
  look: FaceLook
  mine: boolean
}

export interface DeskPass {
  token: string
  id: string
  display_name: string
  hue: number
}

function raise(error: { message: string } | null) {
  if (!error) return
  const message = error.message.replace(/^.*ERROR:\s*/, '').replace(/\n.*$/, '')
  throw new Error(message)
}

export async function listStaff() {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData.user?.id
  const { data, error } = await supabase.from('staff').select('id, display_name, hue, look, owner_id').eq('hidden', false).order('display_name')
  raise(error)
  return ((data ?? []) as Array<{ id: string; display_name: string; hue: number; look: unknown; owner_id: string }>).map((row) => ({
    id: row.id,
    display_name: row.display_name,
    hue: row.hue,
    look: resolveLook(row.look, row.hue),
    mine: row.owner_id === uid,
  }))
}

export async function loadDeskAdmin() {
  const { data: userData } = await supabase.auth.getUser()
  const uid = userData.user?.id
  if (!uid) return false
  const { data, error } = await supabase.from('profiles').select('is_desk_admin').eq('id', uid).maybeSingle()
  if (error) return false
  return Boolean((data as { is_desk_admin?: boolean } | null)?.is_desk_admin)
}

export async function createStaff(name: string, pin: string, look: FaceLook) {
  const { data, error } = await supabase.rpc('create_staff', {
    p_name: name,
    p_pin: pin,
    p_hue: look.color,
    p_look: look,
  })
  raise(error)
  return data as Pick<StaffCard, 'id' | 'display_name' | 'hue'>
}

export async function enterDesk(staffId: string, pin: string) {
  const { data, error } = await supabase.rpc('enter_desk', { p_staff_id: staffId, p_pin: pin })
  raise(error)
  return data as DeskPass
}

function raiseClaimChange(error: { message: string } | null) {
  if (!error) return
  const message = error.message.replace(/^.*ERROR:\s*/, '').replace(/\n.*$/, '')
  if (/ticket_helpers/i.test(message)) {
    throw new Error('放回被帮忙记录拦住了。请在 SQL Editor 再运行一次 supabase/staff.sql。')
  }
  throw new Error(message)
}

export async function claimTicket(ticketId: string, token: string) {
  const { error } = await supabase.rpc('claim_ticket', { p_ticket_id: ticketId, p_token: token })
  raiseClaimChange(error)
}

export async function releaseTicket(ticketId: string, token: string) {
  const { error } = await supabase.rpc('release_ticket', { p_ticket_id: ticketId, p_token: token })
  raiseClaimChange(error)
}

export async function reassignTicket(ticketId: string, staffId: string | null) {
  const { error } = await supabase.rpc('reassign_ticket', { p_ticket_id: ticketId, p_staff_id: staffId })
  raiseClaimChange(error)
}

export interface TicketHelper {
  ticketId: string
  staffId: string
  name: string
}

function raiseHelp(error: { message: string } | null) {
  if (!error) return
  const message = error.message.replace(/^.*ERROR:\s*/, '').replace(/\n.*$/, '')
  if (/help_colleague|leave_help|ticket_helpers|schema cache/i.test(message)) {
    throw new Error('帮助同事还没建好。请在 SQL Editor 再运行一次 supabase/staff.sql。')
  }
  throw new Error(message)
}

export async function listTicketHelpers(ticketIds: string[]) {
  const rows: TicketHelper[] = []
  for (let start = 0; start < ticketIds.length; start += 100) {
    const slice = ticketIds.slice(start, start + 100)
    const { data, error } = await supabase
      .from('ticket_helpers')
      .select('ticket_id, staff_id, staff(display_name)')
      .in('ticket_id', slice)
    raiseHelp(error)
    for (const row of data ?? []) {
      const staff = row.staff as { display_name?: string } | { display_name?: string }[] | null
      const one = Array.isArray(staff) ? staff[0] : staff
      rows.push({
        ticketId: String(row.ticket_id),
        staffId: String(row.staff_id),
        name: one?.display_name ?? '',
      })
    }
  }
  return rows
}

export async function helpColleague(ticketId: string, token: string) {
  const { error } = await supabase.rpc('help_colleague', { p_ticket_id: ticketId, p_token: token })
  raiseHelp(error)
}

export async function leaveHelp(ticketId: string, token: string) {
  const { error } = await supabase.rpc('leave_help', { p_ticket_id: ticketId, p_token: token })
  raiseHelp(error)
}

export async function updateMyStaff(token: string, name: string, pin: string) {
  const { data, error } = await supabase.rpc('update_my_staff', { p_token: token, p_name: name, p_pin: pin })
  raise(error)
  return String(data ?? name)
}

export async function updateMyLook(token: string, look: FaceLook) {
  const { data, error } = await supabase.rpc('update_my_look', { p_token: token, p_look: look })
  raise(error)
  const hue = Number(data)
  return Number.isInteger(hue) ? hue : look.color
}

export async function assignClaimFolder(folderId: string, staffId: string | null, token: string) {
  const { error } = await supabase.rpc('assign_claim_folder', {
    p_folder_id: folderId,
    p_staff_id: staffId,
    p_token: token,
  })
  raise(error)
}

export async function applyAutoClaims() {
  const { error } = await supabase.rpc('apply_auto_claims')
  raise(error)
}

export function claimSetupHint(err: unknown) {
  const message = err instanceof Error ? err.message : ''
  if (/assign_claim_folder|apply_auto_claims|schema cache/i.test(message)) {
    return '领取函数还没装上。请在 SQL Editor 把 supabase/staff.sql 整份运行一次。'
  }
  if (/claim_staff_id|claim_auto/i.test(message)) {
    return '自动领取还没建好。请在 SQL Editor 先运行 supabase/ticket_ops.sql，再运行 supabase/staff.sql。'
  }
  return message || '自动领取没有保存'
}

export function missingStaffSetup(message: string) {
  return /staff|claimed_by|create_staff|is_desk_admin|p_look|rename_staff|admin_staff_list|hidden|has_claimed|update_my_staff|update_my_look|set_staff_pin|assign_claim_folder|apply_auto_claims/i.test(message)
}

export interface AdminStaff {
  id: string
  display_name: string
  hue: number
  look: FaceLook
  hidden: boolean
  has_claimed: boolean
  open_count: number
  pin: string | null
  tickets: Array<{ id: string; title: string }>
}

export async function listAdminStaff() {
  const { data, error } = await supabase.rpc('admin_staff_list')
  raise(error)
  const parsed = typeof data === 'string' ? (JSON.parse(data) as unknown) : data
  const rows = (Array.isArray(parsed) ? parsed : []) as Array<AdminStaff & { look: unknown }>
  return rows
    .map((row) => ({
      ...row,
      look: resolveLook(row.look, row.hue),
      open_count: Number(row.open_count) || 0,
      tickets: Array.isArray(row.tickets) ? row.tickets : [],
      hidden: Boolean(row.hidden),
      has_claimed: Boolean(row.has_claimed),
      pin: typeof row.pin === 'string' && row.pin ? row.pin : null,
    }))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.display_name.localeCompare(b.display_name, 'zh'))
}

export async function renameStaff(staffId: string, name: string) {
  const { error } = await supabase.rpc('rename_staff', { p_staff_id: staffId, p_name: name })
  raise(error)
}

export async function setStaffPin(staffId: string, pin: string) {
  const { error } = await supabase.rpc('set_staff_pin', { p_staff_id: staffId, p_pin: pin })
  raise(error)
}

export async function setStaffHidden(staffId: string, hidden: boolean) {
  const { error } = await supabase.rpc('set_staff_hidden', { p_staff_id: staffId, p_hidden: hidden })
  raise(error)
}

export async function deleteStaff(staffId: string) {
  const { error } = await supabase.rpc('delete_staff', { p_staff_id: staffId })
  raise(error)
}
