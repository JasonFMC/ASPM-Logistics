import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ImageOverlay,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Rectangle,
  Tooltip,
  useMap,
  useMapEvents,
  Pane,
} from 'react-leaflet'
import L from 'leaflet'
import type { Area, Location, Site } from '../lib/types'
import { LOCATION_COLORS } from '../lib/types'
import { basemapPublicUrl } from '../lib/supabase'
import { areaHasOutline, boxFromPolygon, type MapBox } from '../lib/mapGeometry'
import 'leaflet/dist/leaflet.css'

export type MapInteractMode = 'none' | 'place' | 'box' | 'draw'

export type { MapBox }

interface YardMapProps {
  site: Site
  locations: Location[]
  areas?: Area[]
  focusAreaId?: string | null
  highlightLocationId?: string | null
  selectedLocationId?: string | null
  onSelectLocation?: (location: Location) => void
  onSelectArea?: (area: Area) => void
  viewMode?: 'overview' | 'detail'
  interactMode?: MapInteractMode
  placeMode?: boolean
  pendingPoint?: { x: number; y: number } | null
  pendingBox?: MapBox | null
  /** In-progress hand-drawn outline [[x,y], ...] */
  pendingPolygon?: number[][] | null
  onPlace?: (x: number, y: number) => void
  onBox?: (box: MapBox) => void
  onDrawVertex?: (x: number, y: number) => void
  showLocations?: boolean
}

function toLatLng(x: number, y: number, height: number): L.LatLngExpression {
  return [height - y, x]
}

function cellBounds(
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  mapHeight: number,
): L.LatLngBoundsExpression {
  return [
    toLatLng(x - halfW, y - halfH, mapHeight) as [number, number],
    toLatLng(x + halfW, y + halfH, mapHeight) as [number, number],
  ]
}

function boxToLatLngBounds(box: MapBox, height: number): L.LatLngBoundsExpression {
  return [
    toLatLng(box.minX, box.minY, height) as [number, number],
    toLatLng(box.maxX, box.maxY, height) as [number, number],
  ]
}

function polygonToLatLngs(polygon: number[][], height: number): L.LatLngExpression[] {
  return polygon.map(([x, y]) => toLatLng(x, y, height))
}

const drawVertexIcon = L.divIcon({
  className: 'draw-vertex-icon',
  html: '<span class="draw-vertex-dot"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

const drawStartIcon = L.divIcon({
  className: 'draw-vertex-icon',
  html: '<span class="draw-vertex-dot start"></span>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})


function ViewController({
  width,
  height,
  focusBox,
}: {
  width: number
  height: number
  focusBox: MapBox | null
}) {
  const map = useMap()
  useEffect(() => {
    if (focusBox) {
      const padX = Math.max(8, (focusBox.maxX - focusBox.minX) * 0.12)
      const padY = Math.max(8, (focusBox.maxY - focusBox.minY) * 0.12)
      map.fitBounds(
        boxToLatLngBounds(
          {
            minX: focusBox.minX - padX,
            maxX: focusBox.maxX + padX,
            minY: focusBox.minY - padY,
            maxY: focusBox.maxY + padY,
          },
          height,
        ),
        { animate: true, maxZoom: 4 },
      )
    } else {
      map.fitBounds(
        [
          [0, 0],
          [height, width],
        ],
        { animate: true },
      )
    }
  }, [map, width, height, focusBox])
  return null
}

function FlyToHighlight({
  location,
  height,
  enabled,
}: {
  location?: Location | null
  height: number
  enabled: boolean
}) {
  const map = useMap()
  useEffect(() => {
    if (!enabled || !location) return
    map.flyTo(toLatLng(location.x, location.y, height), Math.max(map.getZoom(), 1), {
      duration: 0.45,
    })
  }, [location, map, height, enabled])
  return null
}

function PlaceHandler({
  enabled,
  height,
  onPlace,
}: {
  enabled: boolean
  height: number
  onPlace?: (x: number, y: number) => void
}) {
  useMapEvents({
    click(e) {
      if (!enabled || !onPlace) return
      onPlace(e.latlng.lng, height - e.latlng.lat)
    },
  })
  return null
}

function DrawHandler({
  enabled,
  height,
  onDrawVertex,
  onCursor,
}: {
  enabled: boolean
  height: number
  onDrawVertex?: (x: number, y: number) => void
  onCursor?: (point: { x: number; y: number } | null) => void
}) {
  const map = useMap()
  const vertexRef = useRef(onDrawVertex)
  const cursorRef = useRef(onCursor)
  vertexRef.current = onDrawVertex
  cursorRef.current = onCursor

  useEffect(() => {
    if (!enabled) {
      cursorRef.current?.(null)
      return
    }

    const container = map.getContainer()
    container.classList.add('leaflet-draw-cursor')

    const onClick = (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e.originalEvent)
      vertexRef.current?.(e.latlng.lng, height - e.latlng.lat)
    }
    const onMove = (e: L.LeafletMouseEvent) => {
      cursorRef.current?.({ x: e.latlng.lng, y: height - e.latlng.lat })
    }
    const onOut = () => cursorRef.current?.(null)

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)

    return () => {
      container.classList.remove('leaflet-draw-cursor')
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      cursorRef.current?.(null)
    }
  }, [enabled, height, map])

  return null
}

function BoxSelectHandler({
  enabled,
  height,
  onBox,
  onDraft,
}: {
  enabled: boolean
  height: number
  onBox?: (box: MapBox) => void
  onDraft?: (box: MapBox | null) => void
}) {
  const map = useMap()
  const [start, setStart] = useState<L.LatLng | null>(null)

  useEffect(() => {
    if (!enabled) {
      map.dragging.enable()
      setStart(null)
      onDraft?.(null)
      return
    }
    map.dragging.disable()
    return () => {
      map.dragging.enable()
    }
  }, [enabled, map, onDraft])

  useMapEvents({
    mousedown(e) {
      if (!enabled) return
      setStart(e.latlng)
      onDraft?.({
        minX: e.latlng.lng,
        maxX: e.latlng.lng,
        minY: height - e.latlng.lat,
        maxY: height - e.latlng.lat,
      })
    },
    mousemove(e) {
      if (!enabled || !start) return
      const x1 = start.lng
      const y1 = height - start.lat
      const x2 = e.latlng.lng
      const y2 = height - e.latlng.lat
      onDraft?.({
        minX: Math.min(x1, x2),
        maxX: Math.max(x1, x2),
        minY: Math.min(y1, y2),
        maxY: Math.max(y1, y2),
      })
    },
    mouseup(e) {
      if (!enabled || !start || !onBox) return
      const x1 = start.lng
      const y1 = height - start.lat
      const x2 = e.latlng.lng
      const y2 = height - e.latlng.lat
      const box: MapBox = {
        minX: Math.min(x1, x2),
        maxX: Math.max(x1, x2),
        minY: Math.min(y1, y2),
        maxY: Math.max(y1, y2),
      }
      setStart(null)
      if (box.maxX - box.minX < 4 || box.maxY - box.minY < 4) {
        onDraft?.(null)
        return
      }
      onBox(box)
    },
  })

  return null
}

export function YardMap({
  site,
  locations,
  areas = [],
  focusAreaId = null,
  highlightLocationId,
  selectedLocationId,
  onSelectLocation,
  onSelectArea,
  viewMode = 'detail',
  interactMode,
  placeMode,
  pendingPoint,
  pendingBox,
  pendingPolygon,
  onPlace,
  onBox,
  onDrawVertex,
  showLocations,
}: YardMapProps) {
  const width = site.basemap_width
  const height = site.basemap_height
  const mode: MapInteractMode = interactMode ?? (placeMode ? 'place' : 'none')
  const [draftBox, setDraftBox] = useState<MapBox | null>(null)
  const [drawCursor, setDrawCursor] = useState<{ x: number; y: number } | null>(null)
  const drawing = mode === 'draw'

  const bounds = useMemo(
    () =>
      [
        [0, 0],
        [height, width],
      ] as L.LatLngBoundsExpression,
    [width, height],
  )

  const imageUrl = site.basemap_path ? basemapPublicUrl(site.basemap_path) : null
  const [imageOk, setImageOk] = useState(Boolean(imageUrl))
  useEffect(() => {
    setImageOk(Boolean(imageUrl))
  }, [imageUrl])

  const focusArea = areas.find((a) => a.id === focusAreaId) ?? null
  const focusBox = focusArea && areaHasOutline(focusArea) ? boxFromPolygon(focusArea.polygon!) : null

  const markerScaleBox = focusBox ?? {
    minX: 0,
    minY: 0,
    maxX: width,
    maxY: height,
  }
  const halfW = Math.max(6, (markerScaleBox.maxX - markerScaleBox.minX) * 0.045)
  const halfH = Math.max(6, (markerScaleBox.maxY - markerScaleBox.minY) * 0.045)

  const highlight = locations.find((l) => l.id === highlightLocationId) ?? null
  const liveBox = draftBox ?? pendingBox ?? null
  const displayLocations =
    showLocations ?? (viewMode === 'detail' || Boolean(focusAreaId) || Boolean(highlightLocationId))

  const visibleLocations = useMemo(() => {
    if (!focusAreaId) return locations
    return locations.filter((l) => l.area_id === focusAreaId)
  }, [locations, focusAreaId])

  const drawLatLngs =
    pendingPolygon && pendingPolygon.length ? polygonToLatLngs(pendingPolygon, height) : null

  return (
    <div className={`yard-map ${mode !== 'none' ? `${mode}-mode` : ''} view-${viewMode}`}>
      <MapContainer
        key={`${width}x${height}-${site.basemap_path ?? 'none'}`}
        crs={L.CRS.Simple}
        center={[height / 2, width / 2]}
        zoom={0}
        minZoom={-3}
        maxZoom={6}
        style={{ height: '100%', width: '100%', background: '#1c1917' }}
        attributionControl={false}
        maxBounds={[
          [-height * 0.2, -width * 0.2],
          [height * 1.2, width * 1.2],
        ]}
      >
        <ViewController width={width} height={height} focusBox={focusBox} />
        <FlyToHighlight
          location={highlight}
          height={height}
          enabled={viewMode === 'detail' || Boolean(focusAreaId)}
        />
        <PlaceHandler enabled={mode === 'place'} height={height} onPlace={onPlace} />
        <DrawHandler
          enabled={drawing}
          height={height}
          onDrawVertex={onDrawVertex}
          onCursor={setDrawCursor}
        />
        <BoxSelectHandler
          enabled={mode === 'box'}
          height={height}
          onBox={onBox}
          onDraft={setDraftBox}
        />

        {imageUrl && imageOk ? (
          <ImageOverlay
            url={imageUrl}
            bounds={bounds}
            eventHandlers={{ error: () => setImageOk(false) }}
          />
        ) : (
          <ImageOverlay
            url={`data:image/svg+xml,${encodeURIComponent(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
                <rect width="100%" height="100%" fill="#292524"/>
                <text x="50%" y="48%" fill="#a8a29e" font-size="48" text-anchor="middle" font-family="sans-serif">上传场地平面图</text>
                <text x="50%" y="56%" fill="#78716c" font-size="28" text-anchor="middle" font-family="sans-serif">在「管理」页上传</text>
              </svg>`,
            )}`}
            bounds={bounds}
          />
        )}

        <Pane name="areas" style={{ zIndex: 420 }}>
          {areas.filter(areaHasOutline).map((area) => {
            const active = area.id === focusAreaId
            return (
              <Polygon
                key={area.id}
                positions={polygonToLatLngs(area.polygon!, height)}
                interactive={!drawing && mode === 'none'}
                pathOptions={{
                  color: active ? '#f8fafc' : area.color || '#2563eb',
                  fillColor: area.color || '#2563eb',
                  fillOpacity: active ? 0.12 : viewMode === 'overview' ? 0.28 : 0.1,
                  weight: active ? 3 : 2,
                }}
                eventHandlers={{
                  click: () => {
                    if (drawing || mode !== 'none') return
                    onSelectArea?.(area)
                  },
                }}
              >
                <Tooltip direction="center" opacity={0.95} permanent={viewMode === 'overview' && !drawing}>
                  <strong>
                    {area.code} · {area.name}
                  </strong>
                </Tooltip>
              </Polygon>
            )
          })}
        </Pane>

        {displayLocations && (
          <Pane name="locations" style={{ zIndex: 450 }}>
            {visibleLocations.map((loc) => {
              const active = loc.id === selectedLocationId || loc.id === highlightLocationId
              return (
                <Rectangle
                  key={loc.id}
                  bounds={cellBounds(loc.x, loc.y, halfW, halfH, height)}
                  interactive={!drawing && mode === 'none'}
                  pathOptions={{
                    color: active ? '#fafaf9' : LOCATION_COLORS[loc.status],
                    fillColor: LOCATION_COLORS[loc.status],
                    fillOpacity: 0.8,
                    weight: active ? 3 : 1.5,
                  }}
                  eventHandlers={{
                    click: () => {
                      if (drawing || mode !== 'none') return
                      onSelectLocation?.(loc)
                    },
                  }}
                >
                  <Tooltip direction="top" opacity={0.95} sticky>
                    <strong>{loc.code}</strong>
                    {loc.label ? ` · ${loc.label}` : ''}
                  </Tooltip>
                </Rectangle>
              )
            })}
          </Pane>
        )}

        {pendingPoint && (
          <Rectangle
            bounds={cellBounds(pendingPoint.x, pendingPoint.y, halfW * 1.1, halfH * 1.1, height)}
            pathOptions={{
              color: '#0f766e',
              fillColor: '#14b8a6',
              fillOpacity: 0.45,
              weight: 3,
              dashArray: '6 4',
            }}
          >
            <Tooltip permanent direction="top">
              已选落点
            </Tooltip>
          </Rectangle>
        )}

        {liveBox && (
          <Rectangle
            bounds={boxToLatLngBounds(liveBox, height)}
            pathOptions={{
              color: '#ea580c',
              fillColor: '#fdba74',
              fillOpacity: 0.25,
              weight: 2,
              dashArray: '8 6',
            }}
          />
        )}

        {drawLatLngs && drawLatLngs.length > 0 && pendingPolygon && (
          <Pane name="drawing" style={{ zIndex: 650 }}>
            {drawLatLngs.length >= 3 ? (
              <Polygon
                positions={drawLatLngs}
                interactive={false}
                pathOptions={{
                  color: '#f59e0b',
                  fillColor: '#fbbf24',
                  fillOpacity: 0.25,
                  weight: 4,
                }}
              />
            ) : null}
            {drawLatLngs.length >= 2 ? (
              <Polyline
                positions={drawLatLngs}
                interactive={false}
                pathOptions={{ color: '#f59e0b', weight: 4 }}
              />
            ) : null}
            {drawing && drawCursor && pendingPolygon.length > 0 ? (
              <Polyline
                positions={[
                  toLatLng(
                    pendingPolygon[pendingPolygon.length - 1][0],
                    pendingPolygon[pendingPolygon.length - 1][1],
                    height,
                  ),
                  toLatLng(drawCursor.x, drawCursor.y, height),
                ]}
                interactive={false}
                pathOptions={{ color: '#fde68a', weight: 3, dashArray: '6 8' }}
              />
            ) : null}
            {pendingPolygon.map(([x, y], i) => (
              <Marker
                key={`${i}-${x}-${y}`}
                position={toLatLng(x, y, height)}
                icon={i === 0 ? drawStartIcon : drawVertexIcon}
                interactive={false}
              >
                {i === 0 ? (
                  <Tooltip permanent direction="top" offset={[0, -12]}>
                    起点
                  </Tooltip>
                ) : null}
              </Marker>
            ))}
          </Pane>
        )}
      </MapContainer>

      {drawing && (
        <div className="draw-hud">
          手绘中 · 已 {pendingPolygon?.length ?? 0} 点 · 在地图上点击添加顶点
        </div>
      )}
    </div>
  )
}
