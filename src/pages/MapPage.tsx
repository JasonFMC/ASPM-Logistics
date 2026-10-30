import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useYardOps } from '../context/YardOpsContext'
import { useAuth } from '../context/AuthContext'
import { FixedYardBoard } from '../components/FixedYardBoard'
import { ManageSheet } from '../components/ManageSheet'
import { areaHasGoods, createAreaFromPolygon, deleteArea, nextAreaCode } from '../lib/areas'
import { areaHasOutline, describeAreaSize, type MapBox } from '../lib/mapGeometry'
import { supabase } from '../lib/supabase'
import type { Area, Item, Location, Site } from '../lib/types'
import { ITEM_STATUS_LABEL, LOCATION_STATUS_LABEL } from '../lib/types'

type CreateStep = 'idle' | 'drawing'
type MapTool = 'none' | 'place' | 'box' | 'calibrate'

interface SearchHit extends Omit<Item, 'locations'> {
  locations: {
    id: string
    code: string
    label: string | null
    areas: { name: string } | null
  } | null
}

export function MapPage({
  manageRoute = false,
  searchRoute = false,
}: {
  manageRoute?: boolean
  searchRoute?: boolean
}) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const opsNode = useYardOps()
  const [params] = useSearchParams()
  const highlightId = params.get('loc')
  const [mapTool, setMapTool] = useState<MapTool>('none')
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null)
  const [pendingBox, setPendingBox] = useState<MapBox | null>(null)
  const [calA, setCalA] = useState<{ x: number; y: number } | null>(null)
  const [calB, setCalB] = useState<{ x: number; y: number } | null>(null)
  const [calMeters, setCalMeters] = useState('')
  const [calArmed, setCalArmed] = useState(false)
  const [isYardAdmin, setIsYardAdmin] = useState(false)
  const [deleteAreaId, setDeleteAreaId] = useState<string | null>(null)

  const [site, setSite] = useState<Site | null>(null)
  const [areas, setAreas] = useState<Area[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [focusAreaId, setFocusAreaId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Location | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [createStep, setCreateStep] = useState<CreateStep>('idle')
  const [pendingPolygon, setPendingPolygon] = useState<number[][]>([])
  const [busy, setBusy] = useState(false)
  const savingRef = useRef(false)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searched, setSearched] = useState(false)
  const [searchBusy, setSearchBusy] = useState(false)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
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

    const [{ data: areaRows, error: areaError }, { data: locs, error: locError }] =
      await Promise.all([
        supabase.from('areas').select('*').eq('site_id', sites.id).order('sort_order'),
        supabase
          .from('locations')
          .select('*, areas(code, name, color)')
          .eq('site_id', sites.id)
          .order('code'),
      ])

    if (areaError || locError) {
      setError(areaError?.message || locError?.message || '加载失败')
      setLoading(false)
      return
    }

    setAreas((areaRows as Area[]) ?? [])
    setLocations((locs as Location[]) ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!user) {
      setIsYardAdmin(false)
      return
    }
    let cancelled = false
    void supabase
      .from('profiles')
      .select('is_yard_admin')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setIsYardAdmin(Boolean(data?.is_yard_admin))
      })
    return () => {
      cancelled = true
    }
  }, [user])

  useEffect(() => {
    if (!highlightId || !locations.length) return
    const loc = locations.find((l) => l.id === highlightId)
    if (!loc) return
    setSelected(loc)
    if (loc.area_id) setFocusAreaId(loc.area_id)
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

  const outlinedAreas = useMemo(() => areas.filter(areaHasOutline), [areas])
  const focusArea = areas.find((a) => a.id === focusAreaId) ?? null
  const manageOpen = manageRoute && mapTool === 'none' && createStep === 'idle'

  useEffect(() => {
    if (!manageRoute) return
    setCreateStep('idle')
    setPendingPolygon([])
  }, [manageRoute])

  function startCreateArea() {
    setMapTool('none')
    setFocusAreaId(null)
    setSelected(null)
    setPendingPolygon([])
    setCreateStep('drawing')
    setError(null)
    navigate('/yard')
  }

  function beginCalibrate() {
    if (!isYardAdmin) return
    setCreateStep('idle')
    setPendingPolygon([])
    setSelected(null)
    setCalA(null)
    setCalB(null)
    setCalMeters('')
    setCalArmed(false)
    setMapTool('calibrate')
    setError(null)
    navigate('/yard/manage')
  }

  function cancelCalibrate() {
    setCalA(null)
    setCalB(null)
    setCalMeters('')
    setCalArmed(false)
    setMapTool('none')
    setError(null)
  }

  async function saveCalibration() {
    if (!isYardAdmin || !site || !calA || !calB) return
    const meters = Number(calMeters)
    const pixels = Math.hypot(calB.x - calA.x, calB.y - calA.y)
    if (!(meters > 0)) {
      setError('请填写这条线的实际长度，单位是米')
      setCalArmed(false)
      return
    }
    if (pixels < 30) {
      setError('这条线太短。请点在一段更长的地面已知边上，校准才准')
      setCalArmed(false)
      return
    }
    const metersPerPixel = meters / pixels
    if (!calArmed) {
      setCalArmed(true)
      setError(
        `第一次确认：1 像素将改成 ${metersPerPixel.toFixed(4)} 米。再点一次「确认写入」才会保存。`,
      )
      return
    }
    setBusy(true)
    setError(null)
    const { error: updateError } = await supabase
      .from('sites')
      .update({ meters_per_pixel: metersPerPixel })
      .eq('id', site.id)
    setBusy(false)
    if (updateError) {
      setError(updateError.message)
      return
    }
    setSite({ ...site, meters_per_pixel: metersPerPixel })
    cancelCalibrate()
  }

  function beginMapTool(tool: MapTool, areaId: string) {
    setCreateStep('idle')
    setPendingPolygon([])
    setSelected(null)
    setFocusAreaId(areaId)
    setMapTool(tool)
    setError(null)
  }

  async function onSearch(e: FormEvent) {
    e.preventDefault()
    const term = query.trim()
    if (!term) return
    setSearchBusy(true)
    setError(null)
    const pattern = `%${term}%`
    const { data, error: searchError } = await supabase
      .from('items')
      .select('*, locations(id, code, label, areas(name))')
      .or(`code.ilike.${pattern},name.ilike.${pattern}`)
      .neq('status', 'shipped')
      .order('updated_at', { ascending: false })
      .limit(40)
    const { data: locItems, error: locError } = await supabase
      .from('locations')
      .select('id, code, label, areas(name), items(*, locations(id, code, label, areas(name)))')
      .or(`code.ilike.${pattern},label.ilike.${pattern}`)
      .limit(20)
    setSearchBusy(false)
    setSearched(true)
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
      const area = Array.isArray(row.areas) ? (row.areas[0] ?? null) : row.areas
      for (const item of row.items ?? []) {
        if (item.status === 'shipped') continue
        fromLocs.push({
          ...item,
          locations: { id: row.id, code: row.code, label: row.label, areas: area },
        })
      }
    }
    const map = new Map<string, SearchHit>()
    for (const hit of [...fromItems, ...fromLocs]) map.set(hit.id, hit)
    setHits([...map.values()])
  }

  function pickHit(hit: SearchHit) {
    const locId = hit.locations?.id
    if (!locId) return
    const loc = locations.find((item) => item.id === locId)
    if (!loc) return
    setSelected(loc)
    if (loc.area_id) setFocusAreaId(loc.area_id)
  }

  function cancelCreate() {
    setCreateStep('idle')
    setPendingPolygon([])
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
      if (focusAreaId === area.id) {
        setFocusAreaId(null)
        setSelected(null)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除区域失败')
    }
  }

  const onStrokeEnd = useCallback(
    async (closed: number[][]) => {
      if (!site || savingRef.current) return
        if (closed.length < 4) {
        setError('至少点三个角，再双击或点回起点闭合')
        setPendingPolygon([])
        return
      }
      savingRef.current = true
      setBusy(true)
      setError(null)
      try {
        const code = await nextAreaCode(site.id)
        await createAreaFromPolygon({
          siteId: site.id,
          name: code,
          polygon: closed,
        })
        setCreateStep('idle')
        setPendingPolygon([])
        setFocusAreaId(null)
        await load()
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

  if (loading) return <p className="page-status">加载地图…</p>
  if (!site) return <p className="page-status error">{error}</p>

  return (
    <div className="draw-page">
      {isYardAdmin && mapTool === 'calibrate' && (
        <aside className="cal-help">
          <strong>尺寸数据测算</strong>
          <ol>
            <li>选地面上一条已知长度的长边，例如围栏、车道或墙根。不要量屋顶。</li>
            <li>看笔尖对准后单击起点，再单击终点。起点和笔尖之间会有一条虚线。</li>
            <li>拖动两端圆点微调。按住中键移动地图，滚轮放大。</li>
            <li>填写实际米数后先点一次，再点「确认写入」才会改数据库。</li>
          </ol>
        </aside>
      )}
      <FixedYardBoard
        site={site}
        areas={outlinedAreas}
        locations={locations}
        focusAreaId={createStep === 'idle' ? focusAreaId : null}
        selectedLocationId={selected?.id}
        highlightLocationId={createStep === 'idle' ? highlightId : null}
        drawMode={createStep === 'drawing'}
        drawingPoints={pendingPolygon}
        onDrawingChange={setPendingPolygon}
        onStrokeEnd={(pts) => void onStrokeEnd(pts)}
        onCancel={cancelCreate}
        pickMode={mapTool === 'place' || (isYardAdmin && mapTool === 'calibrate')}
        boxMode={mapTool === 'box'}
        guideMode={isYardAdmin && mapTool === 'calibrate'}
        guideLine={calA ? (calB ? [calA, calB] : [calA]) : null}
        onGuidePoint={
          isYardAdmin && mapTool === 'calibrate'
            ? (index, x, y) => {
                setCalArmed(false)
                if (index === 0) setCalA({ x, y })
                else setCalB({ x, y })
                setError(null)
              }
            : undefined
        }
        onPick={(x, y) => {
          if (isYardAdmin && mapTool === 'calibrate') {
            setCalArmed(false)
            if (!calA) setCalA({ x, y })
            else if (!calB) setCalB({ x, y })
            setError(null)
            return
          }
          setPendingPoint({ x, y })
          setMapTool('none')
        }}
        onBox={(box) => {
          setPendingBox(box)
          setMapTool('none')
        }}
        onAreaClick={(area) => {
          if (createStep !== 'idle' || mapTool !== 'none') return
          setFocusAreaId(area.id)
          setSelected(null)
        }}
        onLocationClick={(loc) => {
          if (createStep !== 'idle' || mapTool !== 'none') return
          setSelected(loc)
        }}
      />

      <ManageSheet
        open={manageOpen}
        site={site}
        areas={areas}
        locations={locations}
        onReload={() => load(true)}
        onStartDraw={startCreateArea}
        onFocusArea={(id) => {
          setFocusAreaId(id)
          setSelected(null)
        }}
        pendingPoint={pendingPoint}
        pendingBox={pendingBox}
        onBeginPick={(id) => beginMapTool('place', id)}
        onBeginBox={(id) => beginMapTool('box', id)}
        onBeginCalibrate={beginCalibrate}
        isAdmin={isYardAdmin}
        onClearPoint={() => setPendingPoint(null)}
        onClearBox={() => setPendingBox(null)}
      />
      {opsNode &&
        createPortal(
          searchRoute ? (
            <>
              <form className="ops-line" onSubmit={(e) => void onSearch(e)}>
                <input
                  className="ops-search-field"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="货物编号、名称或位置编码"
                />
                <button className="btn primary" type="submit" disabled={searchBusy}>
                  {searchBusy ? '…' : '查找'}
                </button>
              </form>
              <div className="ops-line">
                <div className="ops-scroll">
                  {error && <span className="error">{error}</span>}
                  {hits.map((hit) => (
                    <button key={hit.id} type="button" className="area-chip" onClick={() => pickHit(hit)}>
                      {hit.code}
                      {hit.locations ? ` · ${hit.locations.code}` : ' · 未定位'}
                    </button>
                  ))}
                  {searched && !searchBusy && hits.length === 0 && !error && (
                    <span className="muted">没有匹配的在场货物</span>
                  )}
                  {!searched && !error && <span className="muted">结果会出现在这里，点一下即可在地图上标出</span>}
                </div>
              </div>
            </>
          ) : isYardAdmin && manageRoute && mapTool === 'calibrate' ? (
            <>
              <div className="ops-line">
                <p className="ops-hint">
                  {!calA
                    ? '点一条已知长度的起点。选地面上的长边。中键拖动，滚轮缩放。'
                    : !calB
                      ? '再点终点。两端圆点可以拖动微调。'
                      : calArmed
                        ? '再点一次「确认写入」才会改掉已保存的比例。'
                        : `图上 ${Math.hypot(calB.x - calA.x, calB.y - calA.y).toFixed(0)} 像素。填写实际米数后先点一次。`}
                </p>
              </div>
              <div className="ops-line">
                <input
                  className="ops-search-field ops-meter"
                  type="number"
                  min={0.1}
                  step={0.1}
                  inputMode="decimal"
                  placeholder="实际米数"
                  value={calMeters}
                  disabled={!calB}
                  onChange={(e) => {
                    setCalMeters(e.target.value)
                    setCalArmed(false)
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !calA || !calB}
                  onClick={() => void saveCalibration()}
                >
                  {busy ? '保存中…' : calArmed ? '确认写入' : '保存校准'}
                </button>
                {calA && (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => {
                      setCalA(null)
                      setCalB(null)
                      setCalMeters('')
                      setCalArmed(false)
                      setError(null)
                    }}
                  >
                    重画
                  </button>
                )}
                <button type="button" className="btn ghost" onClick={cancelCalibrate}>
                  返回管理
                </button>
                {error && <span className="error">{error}</span>}
              </div>
            </>
          ) : manageRoute ? (
            <>
              <div className="ops-line">
                <span className="ops-kicker">管理</span>
                <span className="ops-stat">区域 {outlinedAreas.length}</span>
                <span className="ops-stat">格位 {locations.length}</span>
                {mapTool === 'place' && <span className="ok">在地图上点一下落点</span>}
                {mapTool === 'box' && <span className="ok">按住拖出格位矩形</span>}
              </div>
              <div className="ops-line">
                <div className="ops-scroll">
                  {error && <span className="error">{error}</span>}
                  {mapTool !== 'none' ? (
                    <button type="button" className="btn ghost" onClick={() => setMapTool('none')}>
                      返回管理
                    </button>
                  ) : (
                    <span className="muted">在上方面板上传底图、维护区域和格位</span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="ops-line">
                {mapTool === 'place' || mapTool === 'box' ? (
                  <span className="ok">{mapTool === 'place' ? '在地图上点一下落点' : '按住拖出格位矩形'}</span>
                ) : createStep === 'idle' ? (
                  <button type="button" className="btn primary" onClick={startCreateArea}>
                    新增区域
                  </button>
                ) : (
                  <button type="button" className="btn ghost" onClick={cancelCreate} disabled={busy}>
                    {busy ? '正在保存…' : '取消绘制'}
                  </button>
                )}
                <div className="ops-scroll">
                  {outlinedAreas.map((area) => (
                    <button
                      key={area.id}
                      type="button"
                      className={`area-chip ${focusAreaId === area.id ? 'active' : ''}`}
                      style={{ borderColor: area.color }}
                      disabled={createStep !== 'idle' || mapTool !== 'none'}
                      onClick={() => {
                        setFocusAreaId(area.id)
                        setSelected(null)
                      }}
                    >
                      {area.name}
                    </button>
                  ))}
                  {outlinedAreas.length === 0 && createStep === 'idle' && (
                    <span className="muted">还没有区域</span>
                  )}
                </div>
              </div>
              <div className="ops-line">
                {createStep === 'drawing' ? (
                  <p className="ops-hint">
                    {error ||
                      (busy
                        ? '正在保存区域…'
                        : '单击加点，笔尖会跟着走。拖动圆点微调。双击、回车或点回起点闭合。右键撤销上一个点，ESC取消。中键移动地图，滚轮缩放。')}
                  </p>
                ) : (
                <div className="ops-scroll">
                  {error && <span className="error">{error}</span>}
                  {focusArea && createStep === 'idle' && mapTool === 'none' && (
                    deleteAreaId === focusArea.id ? (
                      <>
                        <button type="button" className="btn danger" onClick={() => void onDeleteArea(focusArea)}>
                          确定
                        </button>
                        <button type="button" className="btn ghost" onClick={() => setDeleteAreaId(null)}>
                          取消
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn danger" onClick={() => void armDeleteArea(focusArea)}>
                        删除 {focusArea.name}
                      </button>
                    )
                  )}
                  {focusArea &&
                    createStep === 'idle' &&
                    mapTool === 'none' &&
                    site.meters_per_pixel &&
                    focusArea.polygon && (
                      <span className="muted">{describeAreaSize(focusArea.polygon, site.meters_per_pixel)}</span>
                    )}
                  {createStep === 'idle' && mapTool === 'none' && selected && (
                    <>
                      <strong>{selected.code}</strong>
                      <span className="muted">{LOCATION_STATUS_LABEL[selected.status]}</span>
                      {items.slice(0, 3).map((item) => (
                        <Link key={item.id} to={`/item/${item.id}`}>
                          {item.code}
                          {item.name ? ` ${item.name}` : ''} · {ITEM_STATUS_LABEL[item.status]}
                        </Link>
                      ))}
                      <Link className="btn primary" to={`/yard/item/new?location=${selected.id}`}>
                        新增货物
                      </Link>
                      <button type="button" className="btn ghost" onClick={() => setSelected(null)}>
                        关闭
                      </button>
                    </>
                  )}
                  {!error && !focusArea && !selected && createStep === 'idle' && mapTool === 'none' && (
                    <span className="muted">点选区域后可删除，点格位可查看货物</span>
                  )}
                </div>
                )}
              </div>
            </>
          ),
          opsNode,
        )}
    </div>
  )
}
