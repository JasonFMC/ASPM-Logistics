import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { YardMap } from '../components/YardMap'
import { compressImage } from '../lib/images'
import { supabase } from '../lib/supabase'
import type { Area, Location, Site } from '../lib/types'

export function AdminPage() {
  const [site, setSite] = useState<Site | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [placeMode, setPlaceMode] = useState(false)
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null)
  const [areaId, setAreaId] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [batchFrom, setBatchFrom] = useState(1)
  const [batchTo, setBatchTo] = useState(15)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data: siteRow, error: siteError } = await supabase
      .from('sites')
      .select('*')
      .limit(1)
      .maybeSingle()
    if (siteError || !siteRow) {
      setError(siteError?.message ?? '无场地数据')
      return
    }
    setSite(siteRow as Site)

    const { data: areaRows } = await supabase
      .from('areas')
      .select('*')
      .eq('site_id', siteRow.id)
      .order('sort_order')
    setAreas((areaRows as Area[]) ?? [])
    if (areaRows?.[0] && !areaId) setAreaId(areaRows[0].id)

    const { data: locRows } = await supabase
      .from('locations')
      .select('*, areas(code, name, color)')
      .eq('site_id', siteRow.id)
      .order('code')
    setLocations((locRows as Location[]) ?? [])
  }, [areaId])

  useEffect(() => {
    void load()
  }, [load])

  async function onUploadBasemap(file: File | null) {
    if (!file || !site) return
    setBusy(true)
    setError(null)
    try {
      const compressed = await compressImage(file)
      const path = `${site.id}/basemap.jpg`
      const { error: upError } = await supabase.storage.from('basemaps').upload(path, compressed, {
        contentType: 'image/jpeg',
        upsert: true,
      })
      if (upError) throw upError

      // read dimensions
      const url = URL.createObjectURL(compressed)
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve({ w: img.width, h: img.height })
        img.onerror = reject
        img.src = url
      })
      URL.revokeObjectURL(url)

      const { error: updateError } = await supabase
        .from('sites')
        .update({
          basemap_path: path,
          basemap_width: dims.w,
          basemap_height: dims.h,
        })
        .eq('id', site.id)
      if (updateError) throw updateError

      setMessage('平面图已更新')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  async function createLocation(x: number, y: number, locCode: string, locLabel: string) {
    if (!site) return
    const { error: insertError } = await supabase.from('locations').insert({
      site_id: site.id,
      area_id: areaId || null,
      code: locCode,
      label: locLabel || null,
      x,
      y,
      status: 'empty',
    })
    if (insertError) throw insertError
  }

  async function onAddLocation(e: FormEvent) {
    e.preventDefault()
    if (!pendingPoint) {
      setError('请先在地图上点选位置')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createLocation(pendingPoint.x, pendingPoint.y, code.trim(), label.trim())
      setCode('')
      setLabel('')
      setPendingPoint(null)
      setPlaceMode(false)
      setMessage('位置已添加')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  async function onBatchGenerate(e: FormEvent) {
    e.preventDefault()
    if (!site || !areaId) return
    const area = areas.find((a) => a.id === areaId)
    if (!area) return

    setBusy(true)
    setError(null)
    try {
      const start = Math.min(batchFrom, batchTo)
      const end = Math.max(batchFrom, batchTo)
      const count = end - start + 1
      const originX = pendingPoint?.x ?? site.basemap_width * 0.15
      const originY = pendingPoint?.y ?? site.basemap_height * 0.2
      const gap = Math.min(site.basemap_width, site.basemap_height) * 0.04

      for (let i = 0; i < count; i++) {
        const n = start + i
        const locCode = `${area.code}-${String(n).padStart(2, '0')}`
        const locLabel = `${area.name}${n}`
        const x = originX + (i % 5) * gap
        const y = originY + Math.floor(i / 5) * gap
        const { error: insertError } = await supabase.from('locations').insert({
          site_id: site.id,
          area_id: area.id,
          code: locCode,
          label: locLabel,
          x,
          y,
          status: 'empty',
        })
        if (insertError && !insertError.message.includes('duplicate')) throw insertError
      }

      setMessage(`已批量生成 ${area.code}-${String(start).padStart(2, '0')} ~ ${area.code}-${String(end).padStart(2, '0')}`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量失败')
    } finally {
      setBusy(false)
    }
  }

  async function onDeleteLocation(loc: Location) {
    if (!confirm(`删除位置 ${loc.code}？`)) return
    const { error: delError } = await supabase.from('locations').delete().eq('id', loc.id)
    if (delError) setError(delError.message)
    else await load()
  }

  if (!site) return <p className="page-status">{error || '加载中…'}</p>

  return (
    <div className="admin-page">
      <div className="page">
        <h1>管理</h1>
        {message && <p className="ok">{message}</p>}
        {error && <p className="error">{error}</p>}

        <section className="section">
          <h2>场地平面图</h2>
          <label className="btn secondary">
            上传平面图
            <input
              type="file"
              accept="image/*"
              hidden
              disabled={busy}
              onChange={(e) => void onUploadBasemap(e.target.files?.[0] ?? null)}
            />
          </label>
        </section>

        <section className="section">
          <h2>添加位置</h2>
          <p className="muted">开启点选后，在下方地图点击放置；也可只点起点再批量生成网格。</p>
          <button
            type="button"
            className={`btn ${placeMode ? 'primary' : 'secondary'}`}
            onClick={() => setPlaceMode((v) => !v)}
          >
            {placeMode ? '点选中…再点地图' : '开启地图点选'}
          </button>
          {pendingPoint && (
            <p className="muted">
              已选坐标：{pendingPoint.x.toFixed(0)}, {pendingPoint.y.toFixed(0)}
            </p>
          )}

          <form className="stack-form" onSubmit={onAddLocation}>
            <label>
              区域
              <select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                {areas.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              位置编码
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A-01" required />
            </label>
            <label>
              原始标签
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="广场右1" />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              添加单个位置
            </button>
          </form>

          <form className="stack-form" onSubmit={onBatchGenerate}>
            <h3>批量生成</h3>
            <div className="row">
              <label>
                从
                <input
                  type="number"
                  min={1}
                  value={batchFrom}
                  onChange={(e) => setBatchFrom(Number(e.target.value))}
                />
              </label>
              <label>
                到
                <input
                  type="number"
                  min={1}
                  value={batchTo}
                  onChange={(e) => setBatchTo(Number(e.target.value))}
                />
              </label>
            </div>
            <button className="btn secondary" type="submit" disabled={busy}>
              按所选区域批量生成
            </button>
          </form>
        </section>

        <section className="section">
          <h2>位置列表 ({locations.length})</h2>
          <ul className="item-list">
            {locations.map((loc) => (
              <li key={loc.id}>
                <div>
                  <strong>{loc.code}</strong>
                  <span>{loc.label}</span>
                </div>
                <button type="button" className="btn ghost small" onClick={() => void onDeleteLocation(loc)}>
                  删除
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="admin-map">
        <YardMap
          site={site}
          locations={locations}
          placeMode={placeMode}
          onPlace={(x, y) => {
            setPendingPoint({ x, y })
            setPlaceMode(false)
            setMessage('已记录落点，可填写编码添加或批量生成')
          }}
        />
      </div>
    </div>
  )
}
