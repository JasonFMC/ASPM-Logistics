import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { YardMap } from '../components/YardMap'
import { supabase } from '../lib/supabase'
import type { Item, Location, Site } from '../lib/types'
import { ITEM_STATUS_LABEL, LOCATION_STATUS_LABEL } from '../lib/types'

export function MapPage() {
  const [params] = useSearchParams()
  const highlightId = params.get('loc')

  const [site, setSite] = useState<Site | null>(null)
  const [locations, setLocations] = useState<Location[]>([])
  const [selected, setSelected] = useState<Location | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)

    const { data: sites, error: siteError } = await supabase
      .from('sites')
      .select('*')
      .limit(1)
      .maybeSingle()

    if (siteError) {
      setError(siteError.message)
      setLoading(false)
      return
    }
    if (!sites) {
      setError('尚未初始化场地，请先运行 supabase/schema.sql')
      setLoading(false)
      return
    }

    setSite(sites)

    const { data: locs, error: locError } = await supabase
      .from('locations')
      .select('*, areas(code, name, color)')
      .eq('site_id', sites.id)
      .order('code')

    if (locError) {
      setError(locError.message)
      setLoading(false)
      return
    }

    setLocations((locs as Location[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!highlightId || !locations.length) return
    const loc = locations.find((l) => l.id === highlightId)
    if (loc) setSelected(loc)
  }, [highlightId, locations])

  useEffect(() => {
    if (!selected) {
      setItems([])
      return
    }
    void (async () => {
      const { data, error: itemError } = await supabase
        .from('items')
        .select('*')
        .eq('location_id', selected.id)
        .neq('status', 'shipped')
        .order('code')
      if (itemError) setError(itemError.message)
      else setItems((data as Item[]) ?? [])
    })()
  }, [selected])

  if (loading) return <p className="page-status">加载地图…</p>
  if (error) return <p className="page-status error">{error}</p>
  if (!site) return null

  return (
    <div className="map-page">
      <YardMap
        site={site}
        locations={locations}
        highlightLocationId={highlightId}
        selectedLocationId={selected?.id}
        onSelectLocation={setSelected}
      />

      <aside className={`sheet ${selected ? 'open' : ''}`}>
        {selected ? (
          <>
            <div className="sheet-head">
              <div>
                <h2>{selected.code}</h2>
                <p>
                  {selected.label || selected.areas?.name || '位置'} ·{' '}
                  {LOCATION_STATUS_LABEL[selected.status]}
                </p>
              </div>
              <button type="button" className="btn ghost" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>

            <div className="sheet-body">
              {items.length === 0 ? (
                <p className="muted">此位置暂无在场货物</p>
              ) : (
                <ul className="item-list">
                  {items.map((item) => (
                    <li key={item.id}>
                      <Link to={`/item/${item.id}`}>
                        <strong>{item.code}</strong>
                        <span>
                          {item.name || '未命名'} · {ITEM_STATUS_LABEL[item.status]}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <Link className="btn primary block" to={`/item/new?location=${selected.id}`}>
                在此新增货物
              </Link>
            </div>
          </>
        ) : (
          <p className="muted center">点击地图上的位置查看货物</p>
        )}
      </aside>
    </div>
  )
}
