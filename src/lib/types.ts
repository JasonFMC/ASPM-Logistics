export type LocationStatus = 'occupied' | 'empty' | 'pending_pickup' | 'special'
export type ItemStatus = 'in_yard' | 'pending_pickup' | 'shipped' | 'special'
export type MovementType = 'inbound' | 'outbound' | 'move' | 'adjust'

export interface Site {
  id: string
  name: string
  basemap_path: string | null
  basemap_width: number
  basemap_height: number
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
