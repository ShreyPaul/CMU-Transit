/*
 * Leaflet map of live vehicles, stops, and route paths centered on Pittsburgh and the CMU campus.
 */
import React, { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, ZoomControl, useMap, useMapEvents } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

import './transit-map.css';
import { useIsDark } from '@/hooks/useIsDark';
import { MapBounds, TransitRoutePath, TransitStop, TransitVehicle } from '@/Interfaces';
import { CMU_CENTER } from '@/api/transit';
import { decodePolyline, escapeHtml, shortRouteLabel, STALE_FIX_SECONDS, ageSeconds, vehicleTitle } from '@/lib/transit';

const RAIL_CODES = new Set(['RED', 'BLUE', 'SLVR', 'BLLB', 'BLSV']);

export interface MapTarget {
  lat: number;
  lng: number;
  zoom?: number;
  /** When set, fit these `[south, west, north, east]` bounds instead of flying to lat/lng. */
  bounds?: [number, number, number, number];
  /** Changes on every request so flying to the same point twice still moves the map. */
  nonce: number;
}

/** One leg of the selected trip option drawn on the map. */
export interface TripLegLine {
  key: string;
  points: [number, number][];
  /** Route color for rides; unset for walking legs, which use the walk style. */
  color?: string;
  walking: boolean;
}

export interface DrawnPath {
  path: TransitRoutePath;
  color: string;
  emphasized: boolean;
}

interface TransitMapProps {
  vehicles: TransitVehicle[];
  stops: TransitStop[];
  paths: DrawnPath[];
  selectedVehicleId: string | null;
  selectedStopId: string | null;
  searchPin: { lat: number; lng: number; label: string } | null;
  myLocation: { lat: number; lng: number } | null;
  tripLines: TripLegLine[];
  tripOrigin: { lat: number; lng: number; label: string } | null;
  target: MapTarget | null;
  clockOffsetMs: number;
  now: number;
  onSelectVehicle: (id: string) => void;
  onSelectStop: (id: string) => void;
  onViewportChange: (bounds: MapBounds, zoom: number) => void;
}

function vehicleIcon(v: TransitVehicle, selected: boolean, stale: boolean): L.DivIcon {
  const isCmu = v.provider === 'CMU_SHUTTLE';
  const isRail = !isCmu && RAIL_CODES.has(String(v.routeCode).toUpperCase());
  const kind = isCmu ? 'tv-cmu' : isRail ? 'tv-rail' : 'tv-prt';
  const label = !v.inService ? '' : isCmu ? shortRouteLabel(v.routeCode) : v.routeCode ?? '';
  const heading =
    v.bearing != null && v.inService
      ? `<span class="tv-heading tv-rot-${Math.round((((v.bearing % 360) + 360) % 360) / 22.5) % 16}"></span>`
      : '';
  const classes = ['tv-vehicle', kind, v.inService ? '' : 'tv-out', selected ? 'tv-selected' : '', stale ? 'tv-stale' : '']
    .filter(Boolean)
    .join(' ');
  const size: [number, number] = isCmu ? [30, 30] : v.inService ? [40, 24] : [16, 16];
  return L.divIcon({
    className: '',
    html: `<div class="${classes}">${heading}<span class="tv-label" aria-hidden="true">${escapeHtml(label)}</span><span class="sr-only">${escapeHtml(vehicleTitle(v))}</span></div>`,
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1] / 2],
  });
}

const pinIcon = L.divIcon({ className: '', html: '<div class="tv-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const originIcon = L.divIcon({ className: '', html: '<div class="tv-origin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
const FALLBACK_RIDE_COLOR = '#6b7280';
const meIcon = L.divIcon({ className: '', html: '<div class="tv-me"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

function ViewportWatcher({ onChange }: { onChange: (b: MapBounds, zoom: number) => void }) {
  const map = useMapEvents({
    moveend: () => report(),
    zoomend: () => report(),
  });
  function report() {
    const b = map.getBounds();
    onChange({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() }, map.getZoom());
  }
  useEffect(() => {
    report();
    // Report once on mount so the page knows the initial viewport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

function FlyTo({ target }: { target: MapTarget | null }) {
  const map = useMap();
  useEffect(() => {
    if (target?.bounds) {
      const [s, w, n, e] = target.bounds;
      // Leave room for the overlays: left search column + right panel on desktop, the bottom sheet on phones/tablets.
      const { x, y } = map.getSize();
      const wide = x >= 1024;
      map.flyToBounds([[s, w], [n, e]], {
        paddingTopLeft: wide ? [416, 40] : [24, 32],
        paddingBottomRight: wide ? [440, 40] : [24, Math.round(y * 0.62)],
        maxZoom: 17,
        duration: 0.6,
      });
    } else if (target) {
      const zoom = target.zoom ?? Math.max(map.getZoom(), 16);
      const { x, y } = map.getSize();
      let center = L.latLng(target.lat, target.lng);
      if (x < 1024) {
        // Phones/tablets: the bottom sheet covers most of the map, so place the target in the strip above it.
        center = map.unproject(map.project(center, zoom).add([0, Math.round(y * 0.3)]), zoom);
      }
      map.flyTo(center, zoom, { duration: 0.6 });
    }
  }, [map, target]);
  return null;
}

export default function TransitMap({
  vehicles,
  stops,
  paths,
  selectedVehicleId,
  selectedStopId,
  searchPin,
  myLocation,
  tripLines,
  tripOrigin,
  target,
  clockOffsetMs,
  now,
  onSelectVehicle,
  onSelectStop,
  onViewportChange,
}: TransitMapProps) {
  const isDark = useIsDark();

  const decodedPaths = useMemo(
    () => paths.map((p) => ({ ...p, points: decodePolyline(p.path.encodedPolyline) })),
    [paths],
  );

  const vehicleMarkers = useMemo(
    () =>
      vehicles.map((v) => {
        const age = ageSeconds(v.reportedAt, clockOffsetMs, now);
        const stale = age != null && age > STALE_FIX_SECONDS;
        const selected = v.id === selectedVehicleId;
        return { v, icon: vehicleIcon(v, selected, stale), selected };
      }),
    // `now` only matters for the stale flag; recompute on vehicle or selection changes and once a minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicles, selectedVehicleId, clockOffsetMs, Math.floor(now / 60000)],
  );

  return (
    <MapContainer center={CMU_CENTER} zoom={15} zoomControl={false} className="h-full w-full" preferCanvas={false}>
      <TileLayer
        key={isDark ? 'dark' : 'light'}
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={19}
        className={isDark ? 'tv-tiles-dark' : undefined}
      />
      <ZoomControl position="bottomright" />
      <ViewportWatcher onChange={onViewportChange} />
      <FlyTo target={target} />

      {decodedPaths.map(({ path, color, emphasized, points }) => (
        <Polyline
          key={path.id + (emphasized ? ':e' : '')}
          positions={points}
          pathOptions={{ color, weight: emphasized ? 6 : 3, opacity: emphasized ? 0.9 : 0.55 }}
        >
          <Tooltip sticky className="tv-tooltip">
            {path.headsign ?? path.directionName ?? path.id}
          </Tooltip>
        </Polyline>
      ))}

      {tripLines.map((l) =>
        l.walking ? (
          <Polyline key={l.key} positions={l.points} pathOptions={{ className: 'tv-walk', weight: 5, dashArray: '2 9', lineCap: 'round' }} />
        ) : (
          <React.Fragment key={l.key}>
            <Polyline positions={l.points} pathOptions={{ className: 'tv-ride-casing', weight: 10, opacity: 1 }} />
            <Polyline positions={l.points} pathOptions={{ color: l.color || FALLBACK_RIDE_COLOR, weight: 6, opacity: 1 }} />
          </React.Fragment>
        ),
      )}

      {stops.map((s) => {
        const selected = s.id === selectedStopId;
        return (
          <React.Fragment key={s.id}>
            <CircleMarker
              center={[s.latitude, s.longitude]}
              radius={selected ? 9 : 6}
              interactive={false}
              pathOptions={{
                className: `tv-stop ${s.provider === 'CMU_SHUTTLE' ? 'tv-stop-cmu' : 'tv-stop-prt'} ${selected ? 'tv-stop-selected' : ''}`,
              }}
            />
            {/* Invisible 44px tap target around the stop. */}
            <CircleMarker
              center={[s.latitude, s.longitude]}
              radius={22}
              pathOptions={{ className: 'tv-stop-hit', stroke: false, fillOpacity: 0 }}
              eventHandlers={{ click: () => onSelectStop(s.id) }}
            >
              <Tooltip direction="top" offset={[0, -12]} className="tv-tooltip">
                {s.stopName}
                {s.servedRouteCodes?.length ? ` · ${s.servedRouteCodes.join(', ')}` : ''}
              </Tooltip>
            </CircleMarker>
          </React.Fragment>
        );
      })}

      {vehicleMarkers.map(({ v, icon, selected }) => (
        <Marker
          key={v.id}
          position={[v.latitude, v.longitude]}
          icon={icon}
          zIndexOffset={selected ? 2000 : v.inService ? (v.provider === 'CMU_SHUTTLE' ? 500 : 0) : -500}
          eventHandlers={{ click: () => onSelectVehicle(v.id) }}
        >
          <Tooltip direction="top" offset={[0, -12]} className="tv-tooltip">
            {vehicleTitle(v)}
          </Tooltip>
        </Marker>
      ))}

      {searchPin && (
        <Marker position={[searchPin.lat, searchPin.lng]} icon={pinIcon} zIndexOffset={3000} keyboard={false}>
          <Tooltip permanent direction="top" offset={[0, -10]} className="tv-tooltip">
            {searchPin.label}
          </Tooltip>
        </Marker>
      )}
      {tripOrigin && (
        <Marker position={[tripOrigin.lat, tripOrigin.lng]} icon={originIcon} zIndexOffset={3000} keyboard={false}>
          <Tooltip direction="top" offset={[0, -10]} className="tv-tooltip">
            From: {tripOrigin.label}
          </Tooltip>
        </Marker>
      )}
      {myLocation && (
        <Marker position={[myLocation.lat, myLocation.lng]} icon={meIcon} zIndexOffset={3000} keyboard={false}>
          <Tooltip direction="top" offset={[0, -10]} className="tv-tooltip">
            You are here
          </Tooltip>
        </Marker>
      )}
    </MapContainer>
  );
}
