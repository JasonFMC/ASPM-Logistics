import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient = isSupabaseConfigured
  ? createClient(url!, anonKey!)
  : (null as unknown as SupabaseClient)

export function photoPublicUrl(path: string) {
  if (!isSupabaseConfigured) return ''
  const { data } = supabase.storage.from('photos').getPublicUrl(path)
  return data.publicUrl
}

export function basemapPublicUrl(path: string) {
  if (!isSupabaseConfigured) return ''
  const { data } = supabase.storage.from('basemaps').getPublicUrl(path)
  return data.publicUrl
}
