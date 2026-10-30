import type { Area } from './types'

export interface MapBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function polygonFromBox(box: MapBox): number[][] {
  return [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ]
}

export function boxFromPolygon(polygon: number[][]): MapBox | null {
  if (!polygon?.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of polygon) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX)) return null
  return { minX, minY, maxX, maxY }
}

/** Area-weighted center of a polygon, in the same coordinate space as the points. */
export function polygonCentroid(points: number[][]): { x: number; y: number } | null {
  if (points.length < 3) return null
  const closed =
    points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]
  const pts = closed ? points.slice(0, -1) : points
  if (pts.length < 3) return null

  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    twiceArea += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (Math.abs(twiceArea) < 1) {
    const sx = pts.reduce((sum, p) => sum + p[0], 0)
    const sy = pts.reduce((sum, p) => sum + p[1], 0)
    return { x: sx / pts.length, y: sy / pts.length }
  }
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) }
}

export function areaHasOutline(area: Area) {
  return Array.isArray(area.polygon) && area.polygon.length >= 3
}

/** Absolute polygon area in the same units as the vertices (image pixels squared). */
export function polygonAreaPx(points: number[][]): number {
  if (points.length < 3) return 0
  const closed =
    points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1]
  const pts = closed ? points.slice(0, -1) : points
  if (pts.length < 3) return 0
  let twice = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    twice += x0 * y1 - x1 * y0
  }
  return Math.abs(twice) / 2
}

export function formatMeters(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

/** Axis-aligned extent and polygon area, after a single meters-per-pixel calibration. */
export function describeAreaSize(polygon: number[][], metersPerPixel: number): string | null {
  const box = boxFromPolygon(polygon)
  if (!box || !(metersPerPixel > 0)) return null
  const widthM = (box.maxX - box.minX) * metersPerPixel
  const heightM = (box.maxY - box.minY) * metersPerPixel
  const areaM2 = polygonAreaPx(polygon) * metersPerPixel * metersPerPixel
  if (widthM <= 0 || heightM <= 0 || areaM2 <= 0) return null
  return `外接约 ${formatMeters(widthM)} × ${formatMeters(heightM)} 米，面积约 ${formatMeters(areaM2)} 平方米`
}

/** If path is not closed, append the first point so it becomes a closed shape. */
export function closePolygon(points: number[][], threshold = 8): number[][] {
  if (points.length < 3) return points
  const [fx, fy] = points[0]
  const [lx, ly] = points[points.length - 1]
  const dist = Math.hypot(fx - lx, fy - ly)
  if (dist <= threshold) {
    const closed = points.slice(0, -1)
    return [...closed, [fx, fy]]
  }
  return [...points, [fx, fy]]
}

/** Thin freehand samples so polygons stay manageable. */
export function simplifyStroke(points: number[][], minDist = 4): number[][] {
  if (points.length <= 2) return points
  const out: number[][] = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1]
    const cur = points[i]
    if (Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) >= minDist) out.push(cur)
  }
  const last = points[points.length - 1]
  const tip = out[out.length - 1]
  if (tip[0] !== last[0] || tip[1] !== last[1]) out.push(last)
  return out
}
