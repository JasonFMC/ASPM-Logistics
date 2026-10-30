import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { Item } from '../lib/types'
import { ITEM_STATUS_LABEL } from '../lib/types'

interface SearchHit extends Omit<Item, 'locations'> {
  locations: {
    id: string
    code: string
    label: string | null
    areas: { name: string } | null
  } | null
}

export function SearchPage() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSearch(e: FormEvent) {
    e.preventDefault()
    const term = q.trim()
    if (!term) return

    setBusy(true)
    setError(null)

    const pattern = `%${term}%`
    const { data, error: searchError } = await supabase
      .from('items')
      .select('*, locations(id, code, label, areas(name))')
      .or(`code.ilike.${pattern},name.ilike.${pattern}`)
      .neq('status', 'shipped')
      .order('updated_at', { ascending: false })
      .limit(40)

    // Also search by location code / area name via locations
    const { data: locItems, error: locError } = await supabase
      .from('locations')
      .select('id, code, label, areas(name), items(*, locations(id, code, label, areas(name)))')
      .or(`code.ilike.${pattern},label.ilike.${pattern}`)
      .limit(20)

    setBusy(false)

    if (searchError || locError) {
      setError(searchError?.message || locError?.message || '搜索失败')
      return
    }

    const fromItems = (data as SearchHit[]) ?? []
    const fromLocs: SearchHit[] = []
    for (const loc of locItems ?? []) {
      const row = loc as {
        id: string
        code: string
        label: string | null
        areas: { name: string } | { name: string }[] | null
        items?: SearchHit[]
      }
      const area = Array.isArray(row.areas) ? row.areas[0] ?? null : row.areas
      const list = row.items ?? []
      for (const item of list) {
        if (item.status === 'shipped') continue
        fromLocs.push({
          ...item,
          locations: {
            id: row.id,
            code: row.code,
            label: row.label,
            areas: area,
          },
        })
      }
    }

    const map = new Map<string, SearchHit>()
    for (const hit of [...fromItems, ...fromLocs]) map.set(hit.id, hit)
    setHits([...map.values()])
  }

  return (
    <div className="page">
      <h1>查找</h1>
      <form className="search-form" onSubmit={onSearch}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="货物编号 / 名称 / 位置编码"
          autoFocus
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? '…' : '搜'}
        </button>
      </form>

      {error && <p className="error">{error}</p>}

      <ul className="item-list">
        {hits.map((hit) => (
          <li key={hit.id}>
            <Link to={`/item/${hit.id}`}>
              <strong>{hit.code}</strong>
              <span>
                {hit.locations
                  ? `${hit.locations.code}${hit.locations.label ? ` · ${hit.locations.label}` : ''}${
                      hit.locations.areas?.name ? ` · ${hit.locations.areas.name}` : ''
                    }`
                  : '未绑定位置'}{' '}
                · {ITEM_STATUS_LABEL[hit.status]}
              </span>
            </Link>
            {hit.locations && (
              <Link className="btn ghost small" to={`/?loc=${hit.locations.id}`}>
                地图
              </Link>
            )}
          </li>
        ))}
      </ul>

      {!busy && hits.length === 0 && q && <p className="muted">无结果</p>}
    </div>
  )
}
