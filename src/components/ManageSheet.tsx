import { useEffect, useRef, useState, type FormEvent } from 'react'
import { areaHasGoods, deleteArea } from '../lib/areas'
import { prepareBasemap } from '../lib/images'
import { areaHasOutline, describeAreaSize } from '../lib/mapGeometry'
import type { MapBox } from '../lib/mapGeometry'
import { supabase } from '../lib/supabase'
import type { Area, Location, Site } from '../lib/types'

function basemapFileName(path: string | null) {
  if (!path) return null
  const base = path.split('/').pop() ?? path
  const legacy = base.match(/^basemap-(\d+)\./)
  if (legacy) {
    const uploaded = new Date(Number(legacy[1]))
    if (!Number.isNaN(uploaded.getTime())) {
      return `平面图 ${uploaded.toLocaleString('zh-CN', { hour12: false })}`
    }
  }
  return base.replace(/^\d+-/, '')
}

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

interface ManageSheetProps {
  open: boolean
  site: Site
  areas: Area[]
  locations: Location[]
  onReload: () => Promise<void>
  onStartDraw: () => void
  onFocusArea: (areaId: string) => void
  pendingPoint: { x: number; y: number } | null
  pendingBox: MapBox | null
  onBeginPick: (areaId: string) => void
  onBeginBox: (areaId: string) => void
  onBeginCalibrate: () => void
  isAdmin: boolean
  onClearPoint: () => void
  onClearBox: () => void
}

export function ManageSheet({
  open,
  site,
  areas,
  locations,
  onReload,
  onStartDraw,
  onFocusArea,
  pendingPoint,
  pendingBox,
  onBeginPick,
  onBeginBox,
  onBeginCalibrate,
  isAdmin,
  onClearPoint,
  onClearBox,
}: ManageSheetProps) {
  const outlined = areas.filter(areaHasOutline)
  const [areaId, setAreaId] = useState('')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [batchFrom, setBatchFrom] = useState(1)
  const [batchTo, setBatchTo] = useState(15)
  const [batchCols, setBatchCols] = useState(5)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [deleteAreaId, setDeleteAreaId] = useState<string | null>(null)
  const [scaleInput, setScaleInput] = useState('')
  const [scaleArmed, setScaleArmed] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const usable = areas.filter(areaHasOutline)
    if (usable.length && !usable.some((a) => a.id === areaId)) {
      setAreaId(usable[0].id)
    }
  }, [areas, areaId])

  useEffect(() => {
    setDeleteArmed(false)
  }, [site.basemap_path])

  useEffect(() => {
    setScaleInput(site.meters_per_pixel != null ? site.meters_per_pixel.toFixed(4) : '')
    setScaleArmed(false)
  }, [site.meters_per_pixel])

  function chooseArea(id: string) {
    setAreaId(id)
    if (id) onFocusArea(id)
  }

  async function onUploadBasemap(file: File | null) {
    if (!file) return
    const current = site.meters_per_pixel
    const keep =
      current != null
        ? `已保存的比例（1 像素 = ${current.toFixed(4)} 米）不会改。`
        : '这次不会填写像素比例。'
    if (!window.confirm(`确定用「${file.name}」替换当前底图？\n${keep}`)) {
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setBusy(true)
    setError(null)
    try {
      const prepared = await prepareBasemap(file)
      const ext = prepared.type === 'image/png' ? 'png' : prepared.type === 'image/webp' ? 'webp' : 'jpg'
      const safeName = file.name.replace(/[^\w.\-()\u4e00-\u9fff]+/g, '_') || `basemap.${ext}`
      const path = `${site.id}/${Date.now()}-${safeName}`
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
      setMessage(`当前平面图已换成「${file.name}」。`)
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setBusy(false)
    }
  }

  async function onSaveScale(e: FormEvent) {
    e.preventDefault()
    const meters = Number(scaleInput)
    if (!(meters > 0)) {
      setError('请填写 1 像素对应的米数')
      setScaleArmed(false)
      return
    }
    const current = site.meters_per_pixel
    if (current != null && Math.abs(current - meters) < 1e-8) {
      setError('这个数和现在保存的一样')
      setScaleArmed(false)
      return
    }
    if (!scaleArmed) {
      setScaleArmed(true)
      setError(null)
      setMessage(
        `第一次确认：1 像素将从 ${current != null ? `${current.toFixed(4)} 米` : '未设置'} 改成 ${meters.toFixed(4)} 米。再点一次「确认写入」才会保存。`,
      )
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: updateError } = await supabase
        .from('sites')
        .update({ meters_per_pixel: meters })
        .eq('id', site.id)
      if (updateError) throw updateError
      setScaleArmed(false)
      setMessage(`尺寸已保存：1 像素 = ${meters.toFixed(4)} 米`)
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存尺寸失败')
    } finally {
      setBusy(false)
    }
  }

  function cancelDeleteBasemap() {
    setDeleteArmed(false)
  }

  async function onDeleteBasemap() {
    if (!site.basemap_path || !deleteArmed) return
    const name = basemapFileName(site.basemap_path) ?? '当前平面图'
    setBusy(true)
    setError(null)
    try {
      const { error: removeError } = await supabase.storage.from('basemaps').remove([site.basemap_path])
      if (removeError) throw removeError
      const { error: updateError } = await supabase
        .from('sites')
        .update({ basemap_path: null })
        .eq('id', site.id)
      if (updateError) throw updateError
      setMessage(`已删除平面图「${name}」`)
      cancelDeleteBasemap()
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除平面图失败')
    } finally {
      setBusy(false)
    }
  }

  async function armDeleteArea(area: Area) {
    setError(null)
    try {
      if (await areaHasGoods(area.id)) {
        setError(`区域「${area.name}」里还有货物，不能删除`)
        return
      }
      setDeleteAreaId(area.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除区域失败')
    }
  }

  async function onDeleteArea(area: Area) {
    if (deleteAreaId !== area.id) return
    setError(null)
    try {
      if (await areaHasGoods(area.id)) {
        setDeleteAreaId(null)
        setError(`区域「${area.name}」里还有货物，不能删除`)
        return
      }
      await deleteArea(area.id)
      setDeleteAreaId(null)
      setMessage('区域已删除')
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除区域失败')
    }
  }

  async function onAddLocation(e: FormEvent) {
    e.preventDefault()
    if (!pendingPoint) {
      setError('请先点「点选单点」，再到地图上点一下')
      return
    }
    if (!areaId) {
      setError('请先选择一个区域')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { error: insertError } = await supabase.from('locations').insert({
        site_id: site.id,
        area_id: areaId,
        code: code.trim(),
        label: label.trim() || null,
        x: pendingPoint.x,
        y: pendingPoint.y,
        status: 'empty',
      })
      if (insertError) throw insertError
      setCode('')
      setLabel('')
      onClearPoint()
      setMessage('位置已添加')
      await onReload()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setBusy(false)
    }
  }

  async function onBatchGenerate(e: FormEvent) {
    e.preventDefault()
    const area = outlined.find((a) => a.id === areaId)
    if (!area) {
      setError('请先选择已有区域')
      return
    }
    if (!pendingBox) {
      setError('请先点「框选生成格位」，在地图上拖出矩形')
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
      onClearBox()
      await onReload()
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
    else await onReload()
  }

  return (
    <div className={`manage-sheet ${open ? 'open' : ''}`} aria-hidden={!open} inert={!open}>
      {(message || error) && (
        <p className={`manage-note ${error ? 'error' : 'ok'}`}>{error || message}</p>
      )}
      <div className="manage-columns">
        <section className="manage-col">
          <h2>区域</h2>
          <div className="area-tool-row">
            <button type="button" className="btn primary" onClick={onStartDraw}>
              在地图上绘制
            </button>
            <button type="button" className="btn light" onClick={() => setBackgroundOpen(true)}>
              仓库背景数据更改
            </button>
          </div>
          <ul className="item-list">
            {outlined.length === 0 ? (
              <li>
                <span className="muted">暂无区域</span>
              </li>
            ) : (
              outlined.map((a) => (
                <li key={a.id}>
                  <div>
                    <strong>{a.name}</strong>
                    <span>{a.code}</span>
                    {site.meters_per_pixel && a.polygon && (
                      <span>{describeAreaSize(a.polygon, site.meters_per_pixel)}</span>
                    )}
                  </div>
                  <div className="manage-actions">
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => chooseArea(a.id)}
                    >
                      选中
                    </button>
                    {deleteAreaId === a.id ? (
                      <>
                        <button type="button" className="btn danger small" onClick={() => void onDeleteArea(a)}>
                          确定
                        </button>
                        <button type="button" className="btn ghost small" onClick={() => setDeleteAreaId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn ghost small" onClick={() => void armDeleteArea(a)}>
                        删除
                      </button>
                    )}
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="manage-col">
          <h2>格位</h2>
          <label>
            当前区域
            <select value={areaId} onChange={(e) => chooseArea(e.target.value)}>
              <option value="">请选择</option>
              {outlined.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          </label>
          <div className="manage-actions">
            <button
              type="button"
              className="btn secondary"
              disabled={!areaId}
              onClick={() => onBeginPick(areaId)}
            >
              点选单点
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={!areaId}
              onClick={() => onBeginBox(areaId)}
            >
              框选生成格位
            </button>
          </div>
          {pendingPoint && (
            <p className="ok">
              已选落点 {pendingPoint.x.toFixed(0)}, {pendingPoint.y.toFixed(0)}
            </p>
          )}
          {pendingBox && (
            <p className="ok">
              已框选 {(pendingBox.maxX - pendingBox.minX).toFixed(0)} ×{' '}
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
            <h3>框内批量</h3>
            <div className="manage-actions">
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
              <label>
                列数
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={batchCols}
                  onChange={(e) => setBatchCols(Number(e.target.value))}
                />
              </label>
            </div>
            <button className="btn secondary" type="submit" disabled={busy || !pendingBox || !areaId}>
              在框内生成
            </button>
          </form>
        </section>

        <section className="manage-col">
          <h2>位置 ({locations.length})</h2>
          <ul className="item-list">
            {locations.length === 0 ? (
              <li>
                <span className="muted">暂无格位</span>
              </li>
            ) : (
              locations.map((loc) => (
                <li key={loc.id}>
                  <div>
                    <strong>{loc.code}</strong>
                    <span>{loc.label}</span>
                  </div>
                  <button type="button" className="btn ghost small" onClick={() => void onDeleteLocation(loc)}>
                    删除
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
      {backgroundOpen && (
        <div className="basemap-dialog" role="dialog" aria-labelledby="basemap-dialog-title">
          <div className="basemap-dialog-card">
            <div className="basemap-dialog-head">
              <h2 id="basemap-dialog-title">仓库背景数据</h2>
              <button type="button" className="btn ghost small" onClick={() => setBackgroundOpen(false)}>
                关闭
              </button>
            </div>
            {isAdmin ? (
              <>
                <p>
                  {site.basemap_path
                    ? `当前平面图：${basemapFileName(site.basemap_path)}`
                    : '当前没有平面图'}
                </p>
                <p className="muted">
                  {site.basemap_path
                    ? `${site.basemap_width} × ${site.basemap_height} px`
                    : '上传后会显示在地图上'}
                </p>
                <div className="basemap-tools">
                  <label className="btn secondary">
                    上传平面图
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      hidden
                      disabled={busy}
                      onChange={(e) => void onUploadBasemap(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <form className="scale-edit" onSubmit={(e) => void onSaveScale(e)}>
                    <span>尺寸校准</span>
                    <div className="scale-edit-line">
                      <span>1 像素 =</span>
                      <input
                        type="number"
                        min={0.0001}
                        step={0.0001}
                        inputMode="decimal"
                        placeholder="米"
                        value={scaleInput}
                        disabled={busy}
                        onChange={(e) => {
                          setScaleInput(e.target.value)
                          setScaleArmed(false)
                        }}
                      />
                      <span>米</span>
                      <button type="submit" className="btn secondary" disabled={busy}>
                        {scaleArmed ? '确认写入' : '保存'}
                      </button>
                    </div>
                  </form>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => {
                      setBackgroundOpen(false)
                      onBeginCalibrate()
                    }}
                  >
                    尺寸数据测算
                  </button>
                  {site.basemap_path && !deleteArmed && (
                    <button type="button" className="btn ghost" disabled={busy} onClick={() => setDeleteArmed(true)}>
                      删除平面图
                    </button>
                  )}
                  {site.basemap_path && deleteArmed && (
                    <div className="basemap-confirm">
                      <button type="button" className="btn danger" disabled={busy} onClick={() => void onDeleteBasemap()}>
                        {busy ? '删除中…' : '确定'}
                      </button>
                      <button type="button" className="btn ghost" disabled={busy} onClick={cancelDeleteBasemap}>
                        取消
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <p>只有管理员有权限更改背景数据，请联系管理员 aspmriverwood@gmail.com。</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
