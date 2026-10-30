import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { FixedYardBoard } from '../components/FixedYardBoard'
import { YardMap, type MapBox, type MapInteractMode } from '../components/YardMap'
import { areaHasGoods, createAreaFromPolygon, deleteArea, nextAreaCode } from '../lib/areas'
import { prepareBasemap } from '../lib/images'
import { areaHasOutline } from '../lib/mapGeometry'
import { supabase } from '../lib/supabase'
import type { Area, Location, Site } from '../lib/types'

type CreateStep = 'idle' | 'drawing'

function gridInsideBox(box: MapBox, count: number, colsHint?: number) {
  const cols = colsHint && colsHint > 0 ? colsHint : Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cellW = (box.maxX - box.minX) / cols
  const cellH = (box.maxY - box.minY) / rows
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    points.push({
      x: box.minX + (c + 0.5) * cellW,
      y: box.minY + (r + 0.5) * cellH,
    })
  }
  return { points, cols, rows, cellW, cellH }
}

export function AdminPage() {
  const [site, setSite] = useState<Site | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [mode, setMode] = useState<MapInteractMode>('none')
  const [createStep, setCreateStep] = useState<CreateStep>('idle')
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null)
  const [pendingBox, setPendingBox] = useState<MapBox | null>(null)
  const [pendingPolygon, setPendingPolygon] = useState<number[][]>([])
  const [areaId, setAreaId] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [batchFrom, setBatchFrom] = useState(1)
  const [batchTo, setBatchTo] = useState(15)
  const [batchCols, setBatchCols] = useState(5)
  const [previewAreaId, setPreviewAreaId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const savingRef = useRef(false)

  const outlinedAreas = useMemo(() => areas.filter(areaHasOutline), [areas])

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
    const list = (areaRows as Area[]) ?? []
    setAreas(list)

    const usable = list.filter(areaHasOutline)
    if (usable.length && !usable.some((a) => a.id === areaId)) {
      setAreaId(usable[0].id)
    }

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
      const prepared = await prepareBasemap(file)
      const ext = prepared.type === 'image/png' ? 'png' : prepared.type === 'image/webp' ? 'webp' : 'jpg'
      const path = `${site.id}/basemap-${Date.now()}.${ext}`
      const { error: upError } = await supabase.storage.from('basemaps').upload(path, prepared, {
        contentType: prepared.type || 'image/jpeg',
        upsert: true,
      })
      if (upError) throw upError

      const url = URL.createObjectURL(prepared)
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

      setPendingPoint(null)
      setPendingBox(null)
      setPendingPolygon([])
      setMessage('平面图已更新。')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  function startCreateArea() {
    setPreviewAreaId(null)
    setPendingBox(null)
    setPendingPoint(null)
    setPendingPolygon([])
    setCreateStep('drawing')
    setMode('none')
    setMessage('点一下设起点，再点一下闭合并保存。右键取消重画')
    setError(null)
  }

  function cancelCreate() {
    setCreateStep('idle')
    setMode('none')
    setPendingPolygon([])
  }

  const onStrokeEnd = useCallback(
    async (closed: number[][]) => {
      if (!site || savingRef.current) return
      if (closed.length < 4) {
        setError('笔画太短，请沿区域边缘移动后再点一下结束')
        setPendingPolygon([])
        return
      }
      savingRef.current = true
      setBusy(true)
      setError(null)
      try {
        const code = await nextAreaCode(site.id)
        const area = await createAreaFromPolygon({
          siteId: site.id,
          name: code,
          polygon: closed,
        })
        setCreateStep('idle')
        setPendingPolygon([])
        setMessage(`已保存区域 ${area.code}`)
        await load()
        setAreaId(area.id)
        setPreviewAreaId(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存区域失败')
        setPendingPolygon([])
      } finally {
        savingRef.current = false
        setBusy(false)
      }
    },
    [site, load],
  )

  async function onDeleteArea(area: Area) {
    setError(null)
    try {
      if (await areaHasGoods(area.id)) {
        setError(`区域「${area.name}」里还有货物，不能删除`)
        return
      }
      if (!confirm(`删除区域「${area.name}」？`)) return
      await deleteArea(area.id)
      setMessage('区域已删除')
      if (previewAreaId === area.id) setPreviewAreaId(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除区域失败')
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
      setError('请先点「点选」，再在地图上点一下')
      return
    }
    if (!areaId) {
      setError('请先新建或选中一个区域')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createLocation(pendingPoint.x, pendingPoint.y, code.trim(), label.trim())
      setCode('')
      setLabel('')
      setPendingPoint(null)
      setMode('none')
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
    const area = outlinedAreas.find((a) => a.id === areaId)
    if (!area) {
      setError('请先选择已有区域')
      return
    }
    if (!pendingBox) {
      setError('请先点「框选生成格位」，在地图上拖出橙色矩形')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const start = Math.min(batchFrom, batchTo)
      const end = Math.max(batchFrom, batchTo)
      const count = end - start + 1
      const { points } = gridInsideBox(pendingBox, count, batchCols)

      for (let i = 0; i < count; i++) {
        const n = start + i
        const locCode = `${area.code}-${String(n).padStart(2, '0')}`
        const locLabel = `${area.name}${n}`
        const { error: insertError } = await supabase.from('locations').insert({
          site_id: site.id,
          area_id: area.id,
          code: locCode,
          label: locLabel,
          x: points[i].x,
          y: points[i].y,
          status: 'empty',
        })
        if (insertError && !insertError.message.includes('duplicate')) throw insertError
      }

      setMessage(
        `已生成 ${area.code}-${String(start).padStart(2, '0')} ~ ${area.code}-${String(end).padStart(2, '0')}`,
      )
      setMode('none')
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

  const mapMode: MapInteractMode = mode === 'draw' ? 'none' : mode
  const showFixedBoard = createStep === 'drawing'

  return (
    <div className="admin-page">
      <div className="page">
        <h1>管理</h1>
        {message && <p className="ok">{message}</p>}
        {error && <p className="error">{error}</p>}

        <section className="section">
          <h2>场地平面图</h2>
          <p className="muted">
            {site.basemap_width} × {site.basemap_height} px。流程：新建区域 → 手绘 → 取名 → 再在区内加格位。
          </p>
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
          <h2>1. 新建区域</h2>
          <p className="muted">点「新增区域」，点一下设起点，再点一下闭合并保存。右键取消重画。</p>

          {createStep === 'idle' && (
            <button type="button" className="btn primary" onClick={startCreateArea}>
              新增区域
            </button>
          )}

          {createStep === 'drawing' && (
            <div className="stack-form">
              <p className="ok">{busy ? '正在保存…' : '再点一下闭合，右键取消重画'}</p>
              <button type="button" className="btn ghost" onClick={cancelCreate} disabled={busy}>
                取消
              </button>
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>已有区域</h3>
          <ul className="item-list">
            {outlinedAreas.length === 0 ? (
              <li>
                <span className="muted">暂无。请先「新建区域」。</span>
              </li>
            ) : (
              outlinedAreas.map((a) => (
                <li key={a.id}>
                  <div>
                    <strong>{a.name}</strong>
                    <span>{a.code}</span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        setAreaId(a.id)
                        setPreviewAreaId(a.id)
                        setCreateStep('idle')
                        setMode('none')
                      }}
                    >
                      选中
                    </button>
                    <button type="button" className="btn ghost small" onClick={() => void onDeleteArea(a)}>
                      删除
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="section">
          <h2>2. 在选中区域内添加位置</h2>
          <p className="muted">先选中区域（地图放大高亮），再点选或框选生成格位。</p>

          <label>
            当前区域
            <select
              value={areaId}
              onChange={(e) => {
                setAreaId(e.target.value)
                setPreviewAreaId(e.target.value || null)
              }}
            >
              <option value="">请选择</option>
              {outlinedAreas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          </label>

          <div className="row" style={{ marginTop: 10 }}>
            <button
              type="button"
              className={`btn ${mode === 'place' ? 'primary' : 'secondary'}`}
              disabled={createStep !== 'idle'}
              onClick={() => {
                setMode((m) => (m === 'place' ? 'none' : 'place'))
                setPendingBox(null)
                setPendingPolygon([])
              }}
            >
              {mode === 'place' ? '点选中…点地图' : '点选单点'}
            </button>
            <button
              type="button"
              className={`btn ${mode === 'box' ? 'primary' : 'secondary'}`}
              disabled={createStep !== 'idle'}
              onClick={() => {
                setPendingPoint(null)
                setPendingPolygon([])
                setMode((m) => (m === 'box' ? 'none' : 'box'))
              }}
            >
              {mode === 'box' ? '框选格位中…' : '框选生成格位'}
            </button>
          </div>

          {pendingPoint && (
            <p className="ok">
              已选落点：{pendingPoint.x.toFixed(0)}, {pendingPoint.y.toFixed(0)}
            </p>
          )}
          {pendingBox && (
            <p className="ok">
              已框选格位范围：{(pendingBox.maxX - pendingBox.minX).toFixed(0)} ×{' '}
              {(pendingBox.maxY - pendingBox.minY).toFixed(0)} px
            </p>
          )}

          <form className="stack-form" onSubmit={onAddLocation}>
            <label>
              位置编码
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="A-01" required />
            </label>
            <label>
              原始标签
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="广场右1" />
            </label>
            <button className="btn primary" type="submit" disabled={busy || !areaId}>
              添加单个位置
            </button>
          </form>

          <form className="stack-form" onSubmit={onBatchGenerate}>
            <h3>框内批量生成格位</h3>
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
            <label>
              每行列数
              <input
                type="number"
                min={1}
                max={30}
                value={batchCols}
                onChange={(e) => setBatchCols(Number(e.target.value))}
              />
            </label>
            <button className="btn secondary" type="submit" disabled={busy || !pendingBox || !areaId}>
              在框选区域内生成
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
        {showFixedBoard ? (
          <FixedYardBoard
            site={site}
            areas={outlinedAreas}
            drawMode={createStep === 'drawing'}
            drawingPoints={pendingPolygon}
            onDrawingChange={(pts) => setPendingPolygon(pts)}
            onStrokeEnd={(pts) => void onStrokeEnd(pts)}
          />
        ) : (
          <YardMap
            site={site}
            locations={locations}
            areas={outlinedAreas}
            focusAreaId={previewAreaId}
            viewMode={previewAreaId ? 'detail' : 'overview'}
            showLocations
            interactMode={mapMode}
            pendingPoint={pendingPoint}
            pendingBox={pendingBox}
            onSelectArea={(area) => {
              setAreaId(area.id)
              setPreviewAreaId(area.id)
            }}
            onPlace={(x, y) => {
              setPendingPoint({ x, y })
              setMode('none')
              setMessage('已选落点，可填写编码后添加')
            }}
            onBox={(box) => {
              setPendingBox(box)
              setMode('none')
              setMessage('已框选格位范围，设置编号后生成')
            }}
          />
        )}
      </div>
    </div>
  )
}
