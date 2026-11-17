/*
 * Display helpers shared by the transit pages.
 */
import { TransitDataSource, TransitProvider, TransitVehicle, TripOption } from '@/Interfaces';

export const PROVIDER_LABEL: Record<TransitProvider, string> = {
  PRT: 'PRT',
  CMU_SHUTTLE: 'CMU Shuttle',
};

/** Rider-friendly names of the two live vehicle feeds. */
export const LIVE_SOURCE_LABEL: Record<string, string> = {
  'prt-gtfsrt-vehicles': 'PRT buses & trains',
  'tripshot-livestatus': 'CMU shuttles',
};

/** A source whose last success is older than this is shown as delayed even if the last call did not fail. */
export const DELAYED_FEED_SECONDS = 120;

export interface FeedIssue {
  id: string;
  label: string;
  message: string;
}

/** Live feeds that failed or are delayed, with a plain-language explanation. */
export function liveFeedIssues(sources: TransitDataSource[], clockOffsetMs: number, now: number): FeedIssue[] {
  return sources.flatMap((s) => {
    const label = LIVE_SOURCE_LABEL[s.id] ?? s.displayName;
    if (s.status === 'ERROR') {
      return [{ id: s.id, label, message: `${label}: not updating right now. Positions older than 5 minutes are hidden.` }];
    }
    const age = ageSeconds(s.lastSuccessAt, clockOffsetMs, now);
    if (s.status === 'OK' && age != null && age > DELAYED_FEED_SECONDS) {
      return [{ id: s.id, label, message: `${label}: delayed, positions may be a few minutes old.` }];
    }
    return [];
  });
}

/** Seconds since the most recent successful pull of any live feed. */
export function freshestFeedAge(sources: TransitDataSource[], clockOffsetMs: number, now: number): number | null {
  const ages = sources.map((s) => ageSeconds(s.lastSuccessAt, clockOffsetMs, now)).filter((a): a is number => a != null);
  return ages.length ? Math.min(...ages) : null;
}

/** Decodes a Google encoded polyline (precision 5) into `[lat, lng]` pairs. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/** Short label drawn inside a shuttle marker: `B Route` → `B`, `PTC & Mill 19` → `PTC`. */
export function shortRouteLabel(routeCode?: string): string {
  if (!routeCode) return '';
  const s = routeCode.replace(/\s*Route$/i, '').trim();
  if (s.length <= 4) return s;
  const firstWord = s.split(/\s+/)[0];
  if (firstWord.length <= 4) return firstWord;
  return s
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 3)
    .map((w) => w[0].toUpperCase())
    .join('');
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export function compassDirection(bearing?: number): string | null {
  if (bearing == null || Number.isNaN(bearing)) return null;
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

export function mph(speedMps?: number): string | null {
  if (speedMps == null) return null;
  return `${Math.round(speedMps * 2.23694)} mph`;
}

/** Seconds elapsed since `iso`, measured on the server clock (`clockOffsetMs` = server minus client). */
export function ageSeconds(iso: string | undefined, clockOffsetMs: number, nowMs: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((nowMs + clockOffsetMs - new Date(iso).getTime()) / 1000));
}

export function formatAge(seconds: number | null): string {
  if (seconds == null) return 'never';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

export function formatClock(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function minutesUntil(iso: string | undefined, clockOffsetMs: number, nowMs: number): number | null {
  if (!iso) return null;
  return Math.round((new Date(iso).getTime() - (nowMs + clockOffsetMs)) / 60000);
}

export function formatMinutes(mins: number | null): string {
  if (mins == null) return '—';
  if (mins <= 0) return 'Due';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function formatDelay(delaySeconds?: number): string | null {
  if (delaySeconds == null) return null;
  const mins = Math.round(delaySeconds / 60);
  if (Math.abs(mins) < 1) return 'On time';
  return mins > 0 ? `${mins} min late` : `${-mins} min early`;
}

/** Minimum zoom at which stops are fetched and drawn, to keep the marker count bounded. */
export const STOP_MIN_ZOOM = 15;

/** GPS fixes older than this are flagged as possibly stale on the map. */
export const STALE_FIX_SECONDS = 180;

export function vehicleTitle(v: TransitVehicle): string {
  if (!v.inService) return `${PROVIDER_LABEL[v.provider]} ${v.vehicleLabel} · Not in service`;
  return `${v.routeCode ?? ''}${v.destination ? ' to ' + v.destination : ''}`.trim();
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Stable identity of a trip option across re-plans, so the user's choice survives a refresh. */
export function optionKey(o: TripOption): string {
  const ride = o.legs?.find((l) => l.mode !== 'WALK');
  return `${o.kind}:${ride?.route?.id ?? 'walk'}:${ride?.tripId ?? ''}`;
}

/** Weekday + time when `iso` is not today in the browser's time zone, otherwise just the time. */
export function formatDayClock(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? formatClock(iso) : d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

