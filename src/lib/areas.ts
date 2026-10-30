import { supabase } from './supabase'
import type { Area } from './types'

const AREA_COLORS = [
  '#2563eb',
  '#16a34a',
  '#ca8a04',
  '#ea580c',
  '#7c3aed',
  '#db2777',
  '#0d9488',
  '#4f46e5',
]

function letterIndex(value: string): number | null {
  if (!/^[A-Z]+$/i.test(value)) return null
  let n = 0
  for (const ch of value.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64)
  }
  return n
}

function indexToLetters(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    x -= 1
    s = String.fromCharCode(65 + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return s
}

function hasOutline(polygon: unknown): boolean {
  return Array.isArray(polygon) && polygon.length >= 3
}

/** First unused letter among areas that are actually drawn: A, then B, then C. */
export async function nextAreaCode(siteId: string): Promise<string> {
  const { data, error } = await supabase.from('areas').select('code, name, polygon').eq('site_id', siteId)
  if (error) throw error
  const used = new Set<number>()
  for (const row of data ?? []) {
    if (!hasOutline(row.polygon)) continue
    const n = letterIndex(row.name) ?? letterIndex(row.code)
    if (n != null) used.add(n)
  }
  let i = 1
  while (used.has(i)) i += 1
  return indexToLetters(i)
}

export async function createAreaFromPolygon(input: {
  siteId: string
  name: string
  polygon: number[][]
  color?: string
}): Promise<Area> {
  if (input.polygon.length < 3) throw new Error('轮廓至少需要 3 个点')
  const name = input.name.trim()
  if (!name) throw new Error('请填写区域名称')

  const code = name
  const { data: placeholders, error: placeholderError } = await supabase
    .from('areas')
    .select('id')
    .eq('site_id', input.siteId)
    .eq('code', code)
    .is('polygon', null)
  if (placeholderError) throw new Error(placeholderError.message)
  for (const row of placeholders ?? []) {
    const { count: locCount, error: locError } = await supabase
      .from('locations')
      .select('id', { count: 'exact', head: true })
      .eq('area_id', row.id)
    if (locError) throw new Error(locError.message)
    if ((locCount ?? 0) > 0) {
      throw new Error(`代号 ${code} 仍被一个未绘制的旧区域占用`)
    }
    const { error: delError } = await supabase.from('areas').delete().eq('id', row.id)
    if (delError) throw new Error(delError.message)
  }

  const { count } = await supabase
    .from('areas')
    .select('*', { count: 'exact', head: true })
    .eq('site_id', input.siteId)

  const color = input.color ?? AREA_COLORS[(count ?? 0) % AREA_COLORS.length]

  const { data, error } = await supabase
    .from('areas')
    .insert({
      site_id: input.siteId,
      code,
      name,
      color,
      polygon: input.polygon,
      sort_order: (count ?? 0) + 1,
    })
    .select('*')
    .single()

  if (error) throw error
  return data as Area
}

/** True when the area still holds goods that have not shipped. */
export async function areaHasGoods(areaId: string): Promise<boolean> {
  const { data: locs, error: locError } = await supabase
    .from('locations')
    .select('id, status')
    .eq('area_id', areaId)
  if (locError) throw new Error(locError.message)

  const rows = locs ?? []
  if (rows.some((loc) => loc.status !== 'empty')) return true

  const locIds = rows.map((loc) => loc.id)
  if (locIds.length === 0) return false

  const { count, error: itemError } = await supabase
    .from('items')
    .select('id', { count: 'exact', head: true })
    .in('location_id', locIds)
    .neq('status', 'shipped')
  if (itemError) throw new Error(itemError.message)
  return (count ?? 0) > 0
}

/** Deletes an area and its empty cells. Refuses when goods are still inside. */
export async function deleteArea(areaId: string): Promise<void> {
  if (await areaHasGoods(areaId)) {
    throw new Error('区域里还有货物，不能删除')
  }

  const { data: locs, error: locError } = await supabase
    .from('locations')
    .select('id')
    .eq('area_id', areaId)
  if (locError) throw new Error(locError.message)

  const locIds = (locs ?? []).map((loc) => loc.id)
  if (locIds.length > 0) {
    const { error: delLocError } = await supabase.from('locations').delete().in('id', locIds)
    if (delLocError) throw new Error(delLocError.message)
  }

  const { error } = await supabase.from('areas').delete().eq('id', areaId)
  if (error) throw new Error(error.message)
}
