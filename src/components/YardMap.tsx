import { useEffect, useMemo, useState } from 'react'
import {
  ImageOverlay,
  MapContainer,
  CircleMarker,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L from 'leaflet'
import type { Location, Site } from '../lib/types'
import { LOCATION_COLORS } from '../lib/types'
import { basemapPublicUrl } from '../lib/supabase'
import 'leaflet/dist/leaflet.css'

interface YardMapProps {
  site: Site
  locations: Location[]
  highlightLocationId?: string | null
  selectedLocationId?: string | null
  onSelectLocation?: (location: Location) => void
  placeMode?: boolean
  onPlace?: (x: number, y: number) => void
}

function FitBounds({ width, height }: { width: number; height: number }) {
  const map = useMap()
  useEffect(() => {
    map.fitBounds([
      [0, 0],
      [height, width],
    ])
  }, [map, width, height])
  return null
}

function FlyToHighlight({
  location,
  width,
  height,
}: {
  location?: Location | null
  width: number
  height: number
}) {
  const map = useMap()
  useEffect(() => {
    if (!location) return
    map.flyTo([height - location.y, location.x], Math.max(map.getZoom(), 1), { duration: 0.6 })
  }, [location, map, width, height])
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
      const x = e.latlng.lng
      const y = height - e.latlng.lat
      onPlace(x, y)
    },
  })
  return null
}

export function YardMap({
  site,
  locations,
  highlightLocationId,
  selectedLocationId,
  onSelectLocation,
  placeMode,
  onPlace,
}: YardMapProps) {
  const width = site.basemap_width
  const height = site.basemap_height
  const bounds = useMemo(
    () =>
      [
        [0, 0],
        [height, width],
      ] as L.LatLngBoundsExpression,
    [width, height],
  )

  const imageUrl = site.basemap_path
    ? basemapPublicUrl(site.basemap_path)
    : null

  const [imageOk, setImageOk] = useState(Boolean(imageUrl))
  useEffect(() => {
    setImageOk(Boolean(imageUrl))
  }, [imageUrl])

  const highlight = locations.find((l) => l.id === highlightLocationId) ?? null

  return (
    <div className={`yard-map ${placeMode ? 'place-mode' : ''}`}>
      <MapContainer
        crs={L.CRS.Simple}
        center={[height / 2, width / 2]}
        zoom={0}
        minZoom={-2}
        maxZoom={4}
        style={{ height: '100%', width: '100%', background: '#1c1917' }}
        attributionControl={false}
      >
        <FitBounds width={width} height={height} />
        <FlyToHighlight location={highlight} width={width} height={height} />
        <PlaceHandler enabled={Boolean(placeMode)} height={height} onPlace={onPlace} />

        {imageUrl && imageOk ? (
          <ImageOverlay
            url={imageUrl}
            bounds={bounds}
            eventHandlers={{
              error: () => setImageOk(false),
            }}
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

        {locations.map((loc) => {
          const active = loc.id === selectedLocationId || loc.id === highlightLocationId
          return (
            <CircleMarker
              key={loc.id}
              center={[height - loc.y, loc.x]}
              radius={active ? 14 : 10}
              pathOptions={{
                color: active ? '#fafaf9' : LOCATION_COLORS[loc.status],
                fillColor: LOCATION_COLORS[loc.status],
                fillOpacity: 0.85,
                weight: active ? 3 : 1,
              }}
              eventHandlers={{
                click: () => onSelectLocation?.(loc),
              }}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={0.95}>
                <strong>{loc.code}</strong>
                {loc.label ? ` · ${loc.label}` : ''}
              </Tooltip>
            </CircleMarker>
          )
        })}
      </MapContainer>
    </div>
  )
}
