/*
 * Typed wrappers around the C3 transit APIs. Every call goes through `c3Call`; failures reject with the server message.
 */
import { c3Call } from '@/c3Action';
import {
  FetchResult,
  GeoPlace,
  LiveSnapshot,
  MapBounds,
  RouteTrip,
  RouteTrips,
  ServiceAlert,
  StopArrivals,
  TransitDataSource,
  TransitRoute,
  TransitRoutePath,
  TransitStop,
  TripEndpoint,
  TripPlan,
  TripPlanSpec,
  TripTimetable,
  VehicleDetail,
} from '@/Interfaces';

/** Center of the CMU campus (the Cut), used as the default map view and to find routes serving campus. */
export const CMU_CENTER: [number, number] = [40.4433, -79.9436];

/** Bounding box around the CMU campus used to derive the routes and stops that serve it. */
const CAMPUS_BOUNDS: MapBounds = { south: 40.4365, west: -79.9535, north: 40.4505, east: -79.9345 };

const STOP_INCLUDE = 'id, provider, stopCode, stopName, latitude, longitude, externalId, servedRouteCodes';

/** Builds a bounding-box filter from map numbers (never user text), so plain formatting is safe. */
function boundsFilter(b: MapBounds): string {
  return (
    `latitude >= ${b.south.toFixed(6)} && latitude <= ${b.north.toFixed(6)} && ` +
    `longitude >= ${b.west.toFixed(6)} && longitude <= ${b.east.toFixed(6)}`
  );
}

export async function fetchLiveSnapshot(force = false): Promise<LiveSnapshot> {
  return (await c3Call('TransitFeed', 'refreshLive', null, [force])) as LiveSnapshot;
}

export async function fetchVehicleDetail(vehicleId: string): Promise<VehicleDetail> {
  return (await c3Call('TransitFeed', 'vehicleDetail', null, [vehicleId])) as VehicleDetail;
}

export async function fetchStopArrivals(stopId: string): Promise<StopArrivals> {
  return (await c3Call('TransitFeed', 'stopArrivals', null, [stopId])) as StopArrivals;
}

export async function fetchAlerts(force = false): Promise<ServiceAlert[]> {
  return ((await c3Call('TransitFeed', 'refreshAlerts', null, [force])) as ServiceAlert[] | null) ?? [];
}

export async function fetchRoutes(): Promise<TransitRoute[]> {
  const res = (await c3Call('TransitRoute', 'fetch', null, [
    {
      include: 'id, provider, routeCode, longName, description, color, externalId, mode',
      order: 'provider, routeCode',
      limit: 500,
      offset: 0,
    },
  ])) as FetchResult<TransitRoute>;
  return res.objs ?? [];
}

export async function fetchPaths(routeIds: string[]): Promise<TransitRoutePath[]> {
  if (!routeIds.length) return [];
  const res = (await c3Call('TransitRoute.Path', 'fetch', null, [
    {
      filter: `intersects(route.id, ${JSON.stringify(routeIds)})`,
      include: 'id, route.id, directionName, headsign, encodedPolyline, pointCount, stopSequence',
      limit: 400,
      offset: 0,
    },
  ])) as FetchResult<TransitRoutePath>;
  return res.objs ?? [];
}

export async function fetchStopsInBounds(bounds: MapBounds, limit = 400): Promise<TransitStop[]> {
  const res = (await c3Call('TransitStop', 'fetch', null, [
    { filter: boundsFilter(bounds), include: STOP_INCLUDE, limit, offset: 0 },
  ])) as FetchResult<TransitStop>;
  return res.objs ?? [];
}

/** Stops on and next to campus; their served routes are the "campus routes" shown first in the UI. */
export async function fetchCampusStops(): Promise<TransitStop[]> {
  return fetchStopsInBounds(CAMPUS_BOUNDS, 500);
}

export async function fetchStop(stopId: string): Promise<TransitStop | null> {
  const res = (await c3Call('TransitStop', 'fetch', null, [
    { filter: `id == ${JSON.stringify(stopId)}`, include: STOP_INCLUDE, limit: 1, offset: 0 },
  ])) as FetchResult<TransitStop>;
  return res.objs?.[0] ?? null;
}

/** Autocomplete suggestions for a partial query, biased toward `near` (defaults to campus). */
export async function searchPlaces(query: string, near: [number, number] = CMU_CENTER): Promise<GeoPlace[]> {
  return ((await c3Call('TransitGeocoder', 'search', null, [query, 8, near[0], near[1]])) as GeoPlace[] | null) ?? [];
}

/** Stops by id (for showing only the stops on a monitored route), in chunks to bound each request. */
export async function fetchStopsByIds(ids: string[]): Promise<TransitStop[]> {
  const out: TransitStop[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const res = (await c3Call('TransitStop', 'fetch', null, [
      { filter: `intersects(id, ${JSON.stringify(chunk)})`, include: STOP_INCLUDE, limit: chunk.length + 1, offset: 0 },
    ])) as FetchResult<TransitStop>;
    out.push(...(res.objs ?? []));
  }
  return out;
}

/** Plans a trip; `departAt` (ISO) omitted means now, `routeIds` empty means any route. */
export async function planTrip(
  from: TripEndpoint,
  to: TripEndpoint,
  departAt?: string,
  routeIds: string[] = [],
): Promise<TripPlan> {
  const spec: TripPlanSpec = {
    fromLatitude: from.latitude,
    fromLongitude: from.longitude,
    toLatitude: to.latitude,
    toLongitude: to.longitude,
  };
  if (departAt) spec.departAt = departAt;
  if (routeIds.length) spec.routeIds = routeIds;
  return (await c3Call('TransitFeed', 'planTrip', null, [spec])) as TripPlan;
}

/** Default trip origin when the user has not shared a location. */
export const CAMPUS_ORIGIN: TripEndpoint = {
  label: 'CMU campus',
  detail: 'The Cut, Forbes Ave',
  latitude: CMU_CENTER[0],
  longitude: CMU_CENTER[1],
  kind: 'campus',
};

/** Running and upcoming trips of the given routes (at most 10) within the next `horizonMinutes`. */
export async function fetchRouteTrips(routeIds: string[], horizonMinutes = 180): Promise<RouteTrips> {
  return (await c3Call('TransitFeed', 'routeTrips', null, [routeIds, horizonMinutes])) as RouteTrips;
}

/** Stop-by-stop times of one trip returned by `fetchRouteTrips`. */
export async function fetchTripTimetable(trip: RouteTrip): Promise<TripTimetable> {
  return (await c3Call('TransitFeed', 'tripTimetable', null, [trip.routeId, trip.tripId, trip.serviceDate ?? null])) as TripTimetable;
}

export async function fetchDataSources(): Promise<TransitDataSource[]> {
  const res = (await c3Call('TransitDataSource', 'fetch', null, [
    { order: 'phase, category, id', limit: 100, offset: 0 },
  ])) as FetchResult<TransitDataSource>;
  return res.objs ?? [];
}

export async function checkAllDataSources(): Promise<TransitDataSource[]> {
  return ((await c3Call('TransitDataSource', 'checkAll', null, [])) as TransitDataSource[] | null) ?? [];
}
