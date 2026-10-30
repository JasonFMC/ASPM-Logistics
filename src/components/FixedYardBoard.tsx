import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import { basemapPublicUrl } from '../lib/supabase'
import {
  areaHasOutline,
  boxFromPolygon,
  closePolygon,
  polygonCentroid,
  simplifyStroke,
  type MapBox,
} from '../lib/mapGeometry'
import type { Area, Location, Site } from '../lib/types'
import { LOCATION_COLORS } from '../lib/types'

interface FixedYardBoardProps {
  site: Site
  areas: Area[]
  locations?: Location[]
  focusAreaId?: string | null
  selectedLocationId?: string | null
  highlightLocationId?: string | null
  drawMode?: boolean
  strokeColor?: string
  drawingPoints?: number[][]
  onDrawingChange?: (points: number[][]) => void
  /** Fired once when the pointer is released and the stroke can be closed. */
  onStrokeEnd?: (closed: number[][]) => void
  /** ESC leaves drawing and drops the current stroke. */
  onCancel?: () => void
  onAreaClick?: (area: Area) => void
  onLocationClick?: (location: Location) => void
  /** Single click places one location point. */
  pickMode?: boolean
  /** Drag draws a rectangle used to generate cells. */
  boxMode?: boolean
  onPick?: (x: number, y: number) => void
  onBox?: (box: MapBox) => void
  /** 管理员测算尺寸时的参考线，不写入区域。 */
  guideLine?: { x: number; y: number }[] | null
  onGuidePoint?: (index: number, x: number, y: number) => void
  guideMode?: boolean
}

export function finalizeDrawnPolygon(points: number[][]): number[][] {
  return closePolygon(simplifyStroke(points, 4), 12)
}

export function FixedYardBoard({
  site,
  areas,
  locations = [],
  focusAreaId = null,
  selectedLocationId = null,
  highlightLocationId = null,
  drawMode = false,
  strokeColor = '#f59e0b',
  drawingPoints = [],
  onDrawingChange,
  onStrokeEnd,
  onCancel,
  onAreaClick,
  onLocationClick,
  pickMode = false,
  boxMode = false,
  onPick,
  onBox,
  guideLine = null,
  onGuidePoint,
  guideMode = false,
}: FixedYardBoardProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const photoRef = useRef<HTMLCanvasElement>(null)
  const bitmapRef = useRef<HTMLImageElement | null>(null)
  const pointsRef = useRef<number[][]>(drawingPoints)
  const boxDrag = useRef<{ x: number; y: number } | null>(null)
  const [, setStroking] = useState(false)
  const strokingRef = useRef(false)
  const penDownRef = useRef(false)
  const [penDown, setPenDown] = useState(false)
  const glideRef = useRef<{ x: number; y: number } | null>(null)
  const drawDragRef = useRef<{ x: number; y: number; imgX: number; imgY: number } | null>(null)
  const liveBoxRef = useRef<MapBox | null>(null)
  const [liveBox, setLiveBox] = useState<MapBox | null>(null)
  const setBox = (box: MapBox | null) => {
    liveBoxRef.current = box
    setLiveBox(box)
  }
  const endRef = useRef(onStrokeEnd)
  const cancelRef = useRef(onCancel)
  const pickRef = useRef(onPick)
  const boxRef = useRef(onBox)
  const guideRef = useRef(onGuidePoint)
  const guideDragRef = useRef<number | null>(null)
  const vertexDragRef = useRef<{ index: number; x: number; y: number; moved: boolean } | null>(null)
  const clickAddRef = useRef<{ x: number; y: number; imgX: number; imgY: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [brushPos, setBrushPos] = useState<{ x: number; y: number } | null>(null)
  // 记下加载失败的那个地址，而不是一个布尔。地址一换，失败状态自动失效，不用在 effect 里重置。
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  // 回调放进 ref，下面的 useCallback 就不必把它们列进依赖。
  // 只能在提交之后赋值：渲染期间写 ref，渲染被丢弃时会留下错位的值。
  useEffect(() => {
    endRef.current = onStrokeEnd
    cancelRef.current = onCancel
    pickRef.current = onPick
    boxRef.current = onBox
    guideRef.current = onGuidePoint
  })

  const naturalW = site.basemap_width
  const naturalH = site.basemap_height
  const imageUrl = site.basemap_path ? basemapPublicUrl(site.basemap_path) : null

  useEffect(() => {
    pointsRef.current = drawingPoints
  }, [drawingPoints])

  useEffect(() => {
    if (drawMode) return
    strokingRef.current = false
    penDownRef.current = false
    glideRef.current = null
    drawDragRef.current = null
    setStroking(false)
    setPenDown(false)
    setBrushPos(null)
    setCursor(null)
  }, [drawMode])

  const imageToStage = useCallback((x: number, y: number) => {
    const svg = svgRef.current
    const stage = stageRef.current
    if (!svg || !stage) return null
    const rect = svg.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const view = viewRef.current
    if (rect.width <= 0 || rect.height <= 0 || view.w <= 0 || view.h <= 0) return null
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    const offsetX = rect.left + (rect.width - view.w * scale) / 2
    const offsetY = rect.top + (rect.height - view.h * scale) / 2
    return {
      x: offsetX + (x - view.minX) * scale - stageRect.left,
      y: offsetY + (y - view.minY) * scale - stageRect.top,
    }
  }, [])

  const placePenAt = useCallback(
    (x: number, y: number) => {
      setCursor({ x, y })
      const svg = svgRef.current
      const stage = stageRef.current
      const ctm = svg?.getScreenCTM()
      if (svg && stage && ctm) {
        const pt = svg.createSVGPoint()
        pt.x = x
        pt.y = y
        const screen = pt.matrixTransform(ctm)
        const rect = stage.getBoundingClientRect()
        setBrushPos({ x: screen.x - rect.left, y: screen.y - rect.top })
        return
      }
      const local = imageToStage(x, y)
      if (local) setBrushPos(local)
    },
    [imageToStage],
  )

  const placePenAtClient = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (!stage) return
    const rect = stage.getBoundingClientRect()
    setBrushPos({ x: clientX - rect.left, y: clientY - rect.top })
  }, [])

  const finishStroke = useCallback(() => {
    if (pointsRef.current.length < 3) return
    strokingRef.current = false
    setStroking(false)
    const pts = pointsRef.current
    const closed = finalizeDrawnPolygon(pts)
    pointsRef.current = closed
    onDrawingChange?.(closed)
    endRef.current?.(closed)
  }, [onDrawingChange])

  const cancelStroke = useCallback(() => {
    strokingRef.current = false
    penDownRef.current = false
    glideRef.current = null
    drawDragRef.current = null
    setStroking(false)
    setPenDown(false)
    pointsRef.current = []
    onDrawingChange?.([])
  }, [onDrawingChange])

  const undoNodes = useCallback(
    (count: number) => {
      penDownRef.current = false
      drawDragRef.current = null
      setPenDown(false)
      const prev = pointsRef.current
      if (prev.length === 0) return
      const next = prev.slice(0, Math.max(0, prev.length - count))
      pointsRef.current = next
      if (next.length === 0) {
        strokingRef.current = false
        glideRef.current = null
        setStroking(false)
        setBrushPos(null)
        setCursor(null)
      }
      onDrawingChange?.(next)
      const last = next[next.length - 1]
      if (last) placePenAt(last[0], last[1])
    },
    [onDrawingChange, placePenAt],
  )

  const focusArea = areas.find((a) => a.id === focusAreaId) ?? null
  const focusBox = focusArea && areaHasOutline(focusArea) ? boxFromPolygon(focusArea.polygon!) : null

  const fullView = useMemo(
    () => ({ minX: 0, minY: 0, w: naturalW, h: naturalH }),
    [naturalW, naturalH],
  )
  const [viewBox, setViewBox] = useState(fullView)
  const viewRef = useRef(viewBox)

  const paintBasemap = useCallback(() => {
    const canvas = photoRef.current
    const stage = stageRef.current
    if (!canvas || !stage) return
    const rect = stage.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, Math.round(rect.width * dpr))
    const h = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#1c1917'
    ctx.fillRect(0, 0, rect.width, rect.height)
    const view = viewRef.current
    if (view.w <= 0 || view.h <= 0) return
    const scale = Math.min(rect.width / view.w, rect.height / view.h)
    const dw = view.w * scale
    const dh = view.h * scale
    const dx = (rect.width - dw) / 2
    const dy = (rect.height - dh) / 2
    const img = bitmapRef.current
    if (img && img.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = scale < 1
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, view.minX, view.minY, view.w, view.h, dx, dy, dw, dh)
    }
    // 边距只看画布和视窗，不看图片。图没到也先发布，免得侧栏等图加载完才跳位。
    const shell = stage.closest('.app-shell')
    if (!(shell instanceof HTMLElement) || !shell.classList.contains('map-bleed')) return
    if (dx >= 112) {
      shell.dataset.letter = 'x'
      shell.style.setProperty('--letter-x', `${Math.floor(dx)}px`)
    } else if (dy >= 64) {
      shell.dataset.letter = 'y'
      shell.style.setProperty('--letter-y', `${Math.floor(dy)}px`)
    } else {
      shell.dataset.letter = 'slim'
    }
  }, [])

  useEffect(() => {
    if (!imageUrl) {
      bitmapRef.current = null
      paintBasemap()
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      bitmapRef.current = img
      paintBasemap()
    }
    // 没有这一条，底图取不到时只会留下一块黑画布，前端不报错也查不出原因。
    img.onerror = () => {
      if (cancelled) return
      bitmapRef.current = null
      setFailedUrl(imageUrl)
      paintBasemap()
    }
    img.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [imageUrl, paintBasemap])

  // 必须是 layout effect 且排在下面那个画笔定位之前：viewRef 要先更新，再绘制。
  useLayoutEffect(() => {
    viewRef.current = viewBox
    paintBasemap()
  }, [paintBasemap, viewBox])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(() => paintBasemap())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [paintBasemap])
  const panRef = useRef<{
    x: number
    y: number
    minX: number
    minY: number
    w: number
    h: number
    scale: number
  } | null>(null)
  const leftPanRef = useRef<{ x: number; y: number; pointerId: number } | null>(null)
  const suppressClickRef = useRef(false)
  const [panning, setPanning] = useState(false)

  useEffect(() => {
    setViewBox(fullView)
  }, [fullView])

  const clientToImage = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const loc = pt.matrixTransform(ctm.inverse())
    if (
      loc.x < viewBox.minX ||
      loc.y < viewBox.minY ||
      loc.x > viewBox.minX + viewBox.w ||
      loc.y > viewBox.minY + viewBox.h
    ) {
      return null
    }
    return { x: loc.x, y: loc.y }
  }, [viewBox])

  const clientToImageClamped = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const loc = pt.matrixTransform(ctm.inverse())
    return {
      x: Math.min(Math.max(0, loc.x), naturalW),
      y: Math.min(Math.max(0, loc.y), naturalH),
    }
  }, [naturalH, naturalW])

  const zoomAt = useCallback(
    (clientX: number, clientY: number, factor: number) => {
      const svg = svgRef.current
      if (!svg) return
      const pt = svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = svg.getScreenCTM()
      if (!ctm) return
      const loc = pt.matrixTransform(ctm.inverse())
      const prev = viewRef.current
      const minW = naturalW / 16
      const nextW = Math.min(naturalW, Math.max(minW, prev.w * factor))
      if (nextW >= naturalW - 0.5) {
        setViewBox(fullView)
        return
      }
      const nextH = prev.h * (nextW / prev.w)
      let nextMinX = loc.x - ((loc.x - prev.minX) / prev.w) * nextW
      let nextMinY = loc.y - ((loc.y - prev.minY) / prev.h) * nextH
      nextMinX = Math.min(Math.max(0, nextMinX), naturalW - nextW)
      nextMinY = Math.min(Math.max(0, nextMinY), naturalH - nextH)
      setViewBox({ minX: nextMinX, minY: nextMinY, w: nextW, h: nextH })
    },
    [fullView, naturalH, naturalW],
  )

  const viewScale = useCallback(() => {
    const svg = svgRef.current
    const view = viewRef.current
    if (!svg || view.w <= 0 || view.h <= 0) return 1
    const rect = svg.getBoundingClientRect()
    return Math.max(Math.min(rect.width / view.w, rect.height / view.h), 0.0001)
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY > 0 ? 1.15 : 1 / 1.15
      zoomAt(event.clientX, event.clientY, factor)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  function startPan(clientX: number, clientY: number, pointerId: number, target: HTMLDivElement) {
    penDownRef.current = false
    setPenDown(false)
    const view = viewRef.current
    panRef.current = {
      x: clientX,
      y: clientY,
      minX: view.minX,
      minY: view.minY,
      w: view.w,
      h: view.h,
      scale: viewScale(),
    }
    setPanning(true)
    target.setPointerCapture(pointerId)
  }

  function vertexHitRadius() {
    return Math.max(12, 18 / viewScale())
  }

  function hitVertex(x: number, y: number) {
    const limit = vertexHitRadius()
    let best = -1
    let bestD = limit
    pointsRef.current.forEach(([px, py], i) => {
      const d = Math.hypot(px - x, py - y)
      if (d <= bestD) {
        best = i
        bestD = d
      }
    })
    return best
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button === 1) {
      e.preventDefault()
      leftPanRef.current = null
      startPan(e.clientX, e.clientY, e.pointerId, e.currentTarget)
      return
    }
    if (e.button === 0 && !drawMode && !pickMode && !boxMode) {
      leftPanRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId }
    }
    if (drawMode && e.button === 2) return
    if (!drawMode && !pickMode && !boxMode) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = clientToImage(e.clientX, e.clientY)
    if (drawMode && e.button === 0) {
      if (!p) return
      const hit = hitVertex(p.x, p.y)
      if (hit >= 0) {
        vertexDragRef.current = { index: hit, x: e.clientX, y: e.clientY, moved: false }
        clickAddRef.current = null
        return
      }
      clickAddRef.current = { x: e.clientX, y: e.clientY, imgX: p.x, imgY: p.y }
      placePenAtClient(e.clientX, e.clientY)
      setCursor(p)
      return
    }
    if (!p) return
    if (pickMode) {
      pickRef.current?.(p.x, p.y)
      return
    }
    if (boxMode) {
      boxDrag.current = p
      setBox({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })
      return
    }
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const pending = leftPanRef.current
    if (pending && !panRef.current && (e.buttons & 1) !== 0) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) >= 4) {
        suppressClickRef.current = true
        leftPanRef.current = null
        startPan(pending.x, pending.y, pending.pointerId, e.currentTarget)
      }
    }
    if (guideDragRef.current != null && (e.buttons & 1) !== 0) {
      const p = clientToImageClamped(e.clientX, e.clientY)
      if (p) {
        guideRef.current?.(guideDragRef.current, p.x, p.y)
        placePenAt(p.x, p.y)
      } else {
        placePenAtClient(e.clientX, e.clientY)
      }
      return
    }
    if (drawMode && vertexDragRef.current && (e.buttons & 1) !== 0) {
      const drag = vertexDragRef.current
      const moved = clientToImageClamped(e.clientX, e.clientY)
      if (moved) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 4) drag.moved = true
        const pts = pointsRef.current.map(([x, y]) => [x, y])
        pts[drag.index] = [moved.x, moved.y]
        pointsRef.current = pts
        onDrawingChange?.(pts)
        placePenAt(moved.x, moved.y)
      }
      return
    }
    const pan = panRef.current
    if (pan) {
      if (guideMode || drawMode) placePenAtClient(e.clientX, e.clientY)
      const dx = (e.clientX - pan.x) / pan.scale
      const dy = (e.clientY - pan.y) / pan.scale
      const minX = Math.min(Math.max(0, pan.minX - dx), Math.max(0, naturalW - pan.w))
      const minY = Math.min(Math.max(0, pan.minY - dy), Math.max(0, naturalH - pan.h))
      setViewBox({ minX, minY, w: pan.w, h: pan.h })
      return
    }
    const p = clientToImage(e.clientX, e.clientY)
    if (drawMode && !vertexDragRef.current) {
      placePenAtClient(e.clientX, e.clientY)
      setCursor(p)
    }
    if (guideMode && guideDragRef.current == null) {
      placePenAtClient(e.clientX, e.clientY)
      setCursor(p)
    }
    if (boxMode && boxDrag.current && p) {
      const start = boxDrag.current
      setBox({
        minX: Math.min(start.x, p.x),
        minY: Math.min(start.y, p.y),
        maxX: Math.max(start.x, p.x),
        maxY: Math.max(start.y, p.y),
      })
      return
    }
  }

  function onDoubleClick(e: MouseEvent<HTMLDivElement>) {
    if (!drawMode || e.button !== 0) return
    e.preventDefault()
    const pts = pointsRef.current
    if (pts.length >= 2) {
      const a = pts[pts.length - 1]
      const b = pts[pts.length - 2]
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) <= vertexHitRadius()) {
        const trimmed = pts.slice(0, -1)
        pointsRef.current = trimmed
        onDrawingChange?.(trimmed)
      }
    }
    finishStroke()
  }

  function onContextMenu(e: MouseEvent<HTMLDivElement>) {
    if (!drawMode) return
    e.preventDefault()
    undoNodes(1)
  }

  useEffect(() => {
    if (!drawMode) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelStroke()
        cancelRef.current?.()
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      finishStroke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawMode, cancelStroke, finishStroke])

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    const vertex = vertexDragRef.current
    vertexDragRef.current = null
    const pendingClick = clickAddRef.current
    clickAddRef.current = null
    if (drawMode && e.button === 0 && (vertex || pendingClick)) {
      if (vertex && !vertex.moved && vertex.index === 0 && pointsRef.current.length >= 3) {
        finishStroke()
      } else if (pendingClick && Math.hypot(e.clientX - pendingClick.x, e.clientY - pendingClick.y) < 4) {
        const pts = pointsRef.current
        const nearStart =
          pts.length >= 3 &&
          Math.hypot(pendingClick.imgX - pts[0][0], pendingClick.imgY - pts[0][1]) <= vertexHitRadius()
        if (nearStart) finishStroke()
        else {
          const next = [...pts.map(([x, y]) => [x, y]), [pendingClick.imgX, pendingClick.imgY]]
          pointsRef.current = next
          onDrawingChange?.(next)
        }
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    const draggedGuide = guideDragRef.current != null
    guideDragRef.current = null
    leftPanRef.current = null
    if (draggedGuide) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    if (e.button === 0) {
      penDownRef.current = false
      setPenDown(false)
      drawDragRef.current = null
      glideRef.current = { x: e.clientX, y: e.clientY }
      const last = pointsRef.current[pointsRef.current.length - 1]
      if (last) placePenAt(last[0], last[1])
    }
    if (panRef.current) {
      panRef.current = null
      setPanning(false)
      if (suppressClickRef.current) {
        window.setTimeout(() => {
          suppressClickRef.current = false
        }, 0)
      }
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    const dragged = boxDrag.current
    const finished = liveBoxRef.current
    boxDrag.current = null
    setBox(null)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    if (boxMode && dragged && finished) {
      setLiveBox(null)
      const w = finished.maxX - finished.minX
      const h = finished.maxY - finished.minY
      if (w > 8 && h > 8) boxRef.current?.(finished)
    }
  }

  useLayoutEffect(() => {
    if (!drawMode || penDown) return
    const last = pointsRef.current[pointsRef.current.length - 1]
    if (!last) return
    placePenAt(last[0], last[1])
  }, [drawMode, drawingPoints, penDown, placePenAt, viewBox])

  const visibleLocations = focusAreaId
    ? locations.filter((l) => l.area_id === focusAreaId)
    : []

  const markerSpan = focusBox
    ? Math.min(focusBox.maxX - focusBox.minX, focusBox.maxY - focusBox.minY)
    : Math.min(viewBox.w, viewBox.h)
  const markerHalf = Math.max(6, markerSpan * 0.035)
  const strokeW = Math.max(3, Math.min(viewBox.w, viewBox.h) * 0.006)
  const mapTool = pickMode || boxMode
  const basemapFailed = Boolean(imageUrl) && failedUrl === imageUrl

  return (
    <div
      className={`fixed-yard-board ${drawMode ? 'is-drawing' : ''} ${guideMode ? 'is-calibrating' : ''} ${mapTool ? 'is-tool' : ''} ${panning ? 'is-panning' : ''}`}
    >
      <div
        ref={stageRef}
        className="fixed-yard-stage"
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault()
        }}
        onAuxClick={(e) => e.preventDefault()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerLeave={() => {
          glideRef.current = null
          if (guideMode && guideDragRef.current == null) {
            setBrushPos(null)
            setCursor(null)
          }
          if (pointsRef.current.length > 0 || penDownRef.current) return
          setBrushPos(null)
          setCursor(null)
        }}
      >
        <canvas ref={photoRef} className="fixed-yard-photo" aria-hidden />
        <svg
          ref={svgRef}
          className="fixed-yard-svg"
          viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {!imageUrl && <rect x={0} y={0} width={naturalW} height={naturalH} fill="#292524" />}

          {areas.filter(areaHasOutline).map((area) => {
            const active = area.id === focusAreaId
            const pts = area.polygon!.map(([x, y]) => `${x},${y}`).join(' ')
            return (
              <polygon
                key={area.id}
                points={pts}
                fill={area.color || '#2563eb'}
                fillOpacity={active ? 0.22 : drawMode ? 0.1 : 0.3}
                stroke={active ? '#ffffff' : area.color || '#2563eb'}
                strokeWidth={active ? strokeW * 1.4 : strokeW}
                style={{
                  cursor: panning ? 'grabbing' : drawMode || mapTool ? 'none' : 'pointer',
                  pointerEvents: drawMode || mapTool ? 'none' : 'auto',
                }}
                onClick={(ev) => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    ev.preventDefault()
                    ev.stopPropagation()
                    return
                  }
                  if (drawMode || mapTool) return
                  ev.stopPropagation()
                  onAreaClick?.(area)
                }}
              />
            )
          })}

          {areas.filter(areaHasOutline).map((area) => {
            const center = polygonCentroid(area.polygon!)
            const box = boxFromPolygon(area.polygon!)
            if (!center || !box) return null
            const span = Math.min(box.maxX - box.minX, box.maxY - box.minY)
            const fontSize = Math.max(strokeW * 4, Math.min(span * 0.22, strokeW * 10))
            return (
              <text
                key={`${area.id}-label`}
                x={center.x}
                y={center.y}
                textAnchor="middle"
                dominantBaseline="central"
                fill="#fffef8"
                stroke="#1c1917"
                strokeWidth={Math.max(fontSize * 0.12, 1)}
                paintOrder="stroke"
                fontSize={fontSize}
                fontWeight={700}
                style={{ pointerEvents: 'none' }}
              >
                {area.name}
              </text>
            )
          })}

          {visibleLocations.map((loc) => {
            const active = loc.id === selectedLocationId || loc.id === highlightLocationId
            return (
              <rect
                key={loc.id}
                x={loc.x - markerHalf}
                y={loc.y - markerHalf}
                width={markerHalf * 2}
                height={markerHalf * 2}
                rx={markerHalf * 0.2}
                fill={LOCATION_COLORS[loc.status]}
                stroke={active ? '#fff' : '#1c1917'}
                strokeWidth={active ? strokeW : strokeW * 0.5}
                style={{
                  cursor: panning ? 'grabbing' : 'pointer',
                  pointerEvents: drawMode || mapTool ? 'none' : 'auto',
                }}
                onClick={(ev) => {
                  if (suppressClickRef.current) {
                    suppressClickRef.current = false
                    ev.preventDefault()
                    ev.stopPropagation()
                    return
                  }
                  if (drawMode || mapTool) return
                  ev.stopPropagation()
                  onLocationClick?.(loc)
                }}
              />
            )
          })}

          {guideLine && guideLine.length > 0 && (
            <g>
              {guideLine.length >= 2 && (
                <polyline
                  points={guideLine.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={strokeW * 1.4}
                  strokeLinecap="round"
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {guideMode && guideLine.length === 1 && cursor && (
                <line
                  x1={guideLine[0].x}
                  y1={guideLine[0].y}
                  x2={cursor.x}
                  y2={cursor.y}
                  stroke="#22d3ee"
                  strokeOpacity={0.85}
                  strokeWidth={strokeW * 1.2}
                  strokeDasharray={`${strokeW * 2} ${strokeW}`}
                  style={{ pointerEvents: 'none' }}
                />
              )}
              {guideLine.map((p, i) => {
                const hitR = Math.max(strokeW * 2.2, 18 / viewScale())
                return (
                  <g key={i}>
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={hitR * 0.55}
                      fill={i === 0 ? '#22d3ee' : '#fff'}
                      stroke="#0e7490"
                      strokeWidth={Math.max(strokeW * 0.45, hitR * 0.08)}
                      style={{ pointerEvents: 'none' }}
                    />
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={hitR}
                      fill="transparent"
                      style={{ cursor: 'grab' }}
                      onPointerDown={(ev) => {
                        if (!onGuidePoint || ev.button !== 0) return
                        ev.preventDefault()
                        ev.stopPropagation()
                        guideDragRef.current = i
                        stageRef.current?.setPointerCapture(ev.pointerId)
                      }}
                    />
                  </g>
                )
              })}
            </g>
          )}

          {liveBox && (
            <rect
              x={liveBox.minX}
              y={liveBox.minY}
              width={liveBox.maxX - liveBox.minX}
              height={liveBox.maxY - liveBox.minY}
              fill="#f59e0b"
              fillOpacity={0.2}
              stroke="#f59e0b"
              strokeWidth={strokeW}
            />
          )}

          {drawingPoints.length > 0 && (
            <>
              <polyline
                points={drawingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={strokeColor}
                strokeWidth={strokeW * 1.2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {drawingPoints.length >= 3 && (
                <polygon
                  points={drawingPoints.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill={strokeColor}
                  fillOpacity={0.18}
                  stroke="none"
                />
              )}
              {drawingPoints.length >= 3 && (
                <line
                  x1={drawingPoints[drawingPoints.length - 1][0]}
                  y1={drawingPoints[drawingPoints.length - 1][1]}
                  x2={drawingPoints[0][0]}
                  y2={drawingPoints[0][1]}
                  stroke={strokeColor}
                  strokeWidth={strokeW}
                  strokeDasharray={`${strokeW * 2} ${strokeW}`}
                />
              )}
              {drawingPoints.map(([x, y], i) => (
                <circle
                  key={i}
                  cx={x}
                  cy={y}
                  r={strokeW * 1.1}
                  fill={i === 0 ? '#ef4444' : strokeColor}
                  stroke="#fff"
                  strokeWidth={strokeW * 0.4}
                />
              ))}
              {drawMode && cursor && drawingPoints.length > 0 && (
                <line
                  x1={drawingPoints[drawingPoints.length - 1][0]}
                  y1={drawingPoints[drawingPoints.length - 1][1]}
                  x2={cursor.x}
                  y2={cursor.y}
                  stroke={strokeColor}
                  strokeOpacity={0.65}
                  strokeWidth={strokeW}
                  strokeDasharray={`${strokeW * 3} ${strokeW * 2}`}
                />
              )}
            </>
          )}
        </svg>

        {basemapFailed && (
          <div className="basemap-error">
            <strong>底图加载失败</strong>
            <code>{site.basemap_path || '(没有设置路径)'}</code>
            <span>检查 Storage 里这个文件还在不在，以及桶是否公开。</span>
          </div>
        )}

        {(drawMode || guideMode) && brushPos && (
          <svg
            className="paint-pen"
            width="48"
            height="48"
            viewBox="0 0 48 48"
            aria-hidden
            style={{
              left: brushPos.x - 8,
              top: brushPos.y - 46,
            }}
          >
            <path d="M40 6 L16 30 L20 34 L44 10 Z" fill="#1c1917" stroke="#fff" strokeWidth="1.2" />
            <path d="M16 30 L8 46 L20 34 Z" fill="#f59e0b" stroke="#fff" strokeWidth="1" />
            <circle cx="8" cy="46" r="1.6" fill="#ef4444" />
          </svg>
        )}
      </div>

    </div>
  )
}
