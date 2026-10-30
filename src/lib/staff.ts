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

export async function claimTicket(ticketId: string, token: string) {
  const { error } = await supabase.rpc('claim_ticket', { p_ticket_id: ticketId, p_token: token })
  raise(error)
}

export async function releaseTicket(ticketId: string, token: string) {
  const { error } = await supabase.rpc('release_ticket', { p_ticket_id: ticketId, p_token: token })
  raise(error)
}

export async function reassignTicket(ticketId: string, staffId: string | null) {
  const { error } = await supabase.rpc('reassign_ticket', { p_ticket_id: ticketId, p_staff_id: staffId })
  raise(error)
}

export async function updateMyStaff(token: string, name: string, pin: string) {
  const { data, error } = await supabase.rpc('update_my_staff', { p_token: token, p_name: name, p_pin: pin })
  raise(error)
  return String(data ?? name)
}

export function missingStaffSetup(message: string) {
  return /staff|claimed_by|create_staff|is_desk_admin|p_look|rename_staff|admin_staff_list|hidden|has_claimed|update_my_staff/i.test(message)
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

export async function setStaffHidden(staffId: string, hidden: boolean) {
  const { error } = await supabase.rpc('set_staff_hidden', { p_staff_id: staffId, p_hidden: hidden })
  raise(error)
}

export async function deleteStaff(staffId: string) {
  const { error } = await supabase.rpc('delete_staff', { p_staff_id: staffId })
  raise(error)
}
