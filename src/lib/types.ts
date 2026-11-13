export type LocationStatus = 'occupied' | 'empty' | 'pending_pickup' | 'special'
export type ItemStatus = 'in_yard' | 'pending_pickup' | 'shipped' | 'special'
export type MovementType = 'inbound' | 'outbound' | 'move' | 'adjust'
export type TicketStatus = 'new' | 'in_progress' | 'waiting' | 'done' | 'cancelled'
export type WaitingReason = 'customer' | 'truck' | 'paper' | 'other'
export type TicketPriority = 'normal' | 'urgent'
export type TicketSource = 'email' | 'manual'
export type TicketBatch = 'test' | 'live'

export interface Site {
  id: string
  name: string
  basemap_path: string | null
  basemap_width: number
  basemap_height: number
  /** Real meters represented by one image pixel. Null until the basemap is calibrated. */
  meters_per_pixel?: number | null
}

export interface Area {
  id: string
  site_id: string
  code: string
  name: string
  color: string
  sort_order: number
  polygon: number[][] | null
}

export interface Location {
  id: string
  site_id: string
  area_id: string | null
  code: string
  label: string | null
  x: number
  y: number
  status: LocationStatus
  notes: string | null
  areas?: Pick<Area, 'code' | 'name' | 'color'> | null
}

export interface Item {
  id: string
  site_id: string
  code: string
  name: string | null
  description: string | null
  location_id: string | null
  status: ItemStatus
  notes: string | null
  created_at: string
  updated_at: string
  locations?: Location | null
}

export interface Photo {
  id: string
  item_id: string
  movement_id: string | null
  storage_path: string
  created_at: string
}

export interface Movement {
  id: string
  item_id: string
  from_location_id: string | null
  to_location_id: string | null
  movement_type: MovementType
  operator_id: string | null
  notes: string | null
  created_at: string
  from_location?: Pick<Location, 'code' | 'label'> | null
  to_location?: Pick<Location, 'code' | 'label'> | null
}

export interface Warehouse {
  id: string
  name: string
  is_home: boolean
  sort_order: number
  archived: boolean
}

export interface Ticket {
  id: string
  title: string
  summary: string | null
  status: TicketStatus
  source: TicketSource
  batch: TicketBatch
  warehouse_id: string | null
  mailbox: string | null
  message_id: string | null
  imap_uid: number | null
  from_name: string | null
  from_email: string | null
  received_at: string | null
  claimed_by?: string | null
  assignee?: { id: string; display_name: string; hue: number } | null
  waiting_reason?: WaitingReason | null
  due_at?: string | null
  priority?: TicketPriority
  item_id?: string | null
  location_id?: string | null
  facts?: TicketFacts | null
  facts_confirmed_at?: string | null
  closed_at?: string | null
  created_at: string
  updated_at: string
  mail_count?: number
  workflow_id?: string | null
  warehouses?: Pick<Warehouse, 'id' | 'name'> | null
}

export interface Workflow {
  id: string
  name: string
  description: string | null
}

export type StageStatus = 'pending' | 'active' | 'waiting' | 'done' | 'skipped'

export interface TicketStage {
  id: string
  ticket_id: string
  step_key: string
  name: string
  description: string | null
  sort_order: number
  kind: string
  optional: boolean
  status: StageStatus
  started_at: string | null
  completed_at: string | null
  remind_note: string | null
}

export interface StageAlert {
  stage_id: string
  ticket_id: string
  stage_name: string
  stage_status: 'active' | 'waiting'
  started_at: string
  remind_note: string | null
  stuck_for: string
  overdue_by: string
  title: string
  ticket_status: TicketStatus
  warehouse_id: string | null
}

export interface TicketFacts {
  reference?: string
  qty?: string
  note?: string
}

export interface TicketNote {
  id: string
  ticket_id: string
  staff_id: string | null
  author_name: string
  body: string
  created_at: string
}

export interface TicketEvent {
  id: string
  ticket_id: string
  from_status: TicketStatus | null
  to_status: TicketStatus
  actor_id: string | null
  note: string | null
  created_at: string
}

export const LOCATION_COLORS: Record<LocationStatus, string> = {
  occupied: '#16a34a',
  empty: '#9ca3af',
  pending_pickup: '#eab308',
  special: '#dc2626',
}

export const LOCATION_STATUS_LABEL: Record<LocationStatus, string> = {
  occupied: '有货',
  empty: '空',
  pending_pickup: '待取走',
  special: '特殊',
}

export const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  in_yard: '在场',
  pending_pickup: '待取走',
  shipped: '已运走',
  special: '特殊',
}
