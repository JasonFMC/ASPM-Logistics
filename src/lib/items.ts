import { supabase } from './supabase'
import type { Item } from './types'

/** Delete all photos for an item from Storage + photos table rows. */
export async function deleteItemPhotos(itemId: string) {
  const { data: photos, error } = await supabase
    .from('photos')
    .select('id, storage_path')
    .eq('item_id', itemId)

  if (error) throw error
  if (!photos?.length) return

  const paths = photos.map((p) => p.storage_path)
  const { error: storageError } = await supabase.storage.from('photos').remove(paths)
  if (storageError) throw storageError

  const { error: deleteError } = await supabase.from('photos').delete().eq('item_id', itemId)
  if (deleteError) throw deleteError
}

/** Mark item shipped, clear location, log outbound, delete photos. */
export async function shipItem(item: Item, operatorId: string, notes?: string) {
  const { error: moveError } = await supabase.from('movements').insert({
    item_id: item.id,
    from_location_id: item.location_id,
    to_location_id: null,
    movement_type: 'outbound',
    operator_id: operatorId,
    notes: notes ?? null,
  })
  if (moveError) throw moveError

  const { error: updateError } = await supabase
    .from('items')
    .update({ status: 'shipped', location_id: null })
    .eq('id', item.id)
  if (updateError) throw updateError

  await deleteItemPhotos(item.id)
}
