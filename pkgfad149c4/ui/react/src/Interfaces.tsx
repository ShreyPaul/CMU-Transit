/*
 * Shared TypeScript shapes for the C3 types this UI reads. Datetimes arrive as ISO-8601 strings.
 */

/** Operator a record comes from (`TransitProvider` enum). */
export type TransitProvider = 'PRT' | 'CMU_SHUTTLE';

/** Health of an external API (`TransitDataSource.Status`). */
export type DataSourceStatus = 'OK' | 'ERROR' | 'NOT_CONFIGURED' | 'NOT_CHECKED';

/** Kind of information a source supplies (`TransitDataSource.Category`). */
export type DataSourceCategory =
  | 'TRANSIT_REALTIME'
  | 'TRANSIT_STATIC'
  | 'WEATHER'
  | 'ELEVATION'
  | 'ROUTING'
  | 'GEOCODING'
  | 'NEWS'
  | 'TRAFFIC'
  | 'MAPS';

/** A reference to another C3 record, as returned when only its id is included. */
export interface C3Ref {
  id: string;
}

/** Page of records returned by `<Type>.fetch`. */
export interface FetchResult<T> {
  objs?: T[];
  count?: number;
  hasMore?: boolean;
}

/** `TransitRoute`: a PRT route or CMU shuttle route. */
export interface TransitRoute {
  id: string;
  provider: TransitProvider;
  routeCode: string;
  longName?: string;
  description?: string;
  color?: string;
  externalId: string;
  mode?: string;
}

/** `TransitRoute.Path`: drawn geometry of one direction of a route. */
export interface TransitRoutePath {
  id: string;
  route: C3Ref;
  directionName?: string;
  headsign?: string;
  encodedPolyline: string;
  pointCount?: number;
  /** TransitStop ids in travel order. */
  stopSequence?: string[];
  stopOffsetsSec?: number[];
}

/** `TransitStop`: a PRT stop or CMU shuttle stop. */
export interface TransitStop {
  id: string;
  provider: TransitProvider;
  stopCode?: string;
  stopName: string;
  latitude: number;
  longitude: number;
  externalId: string;
  servedRouteCodes?: string[];
}

/** `TransitVehicle`: latest known position of one bus, train, or shuttle. */
export interface TransitVehicle {
  id: string;
  provider: TransitProvider;
  vehicleLabel: string;
  inService?: boolean;
  route?: C3Ref;
  routeCode?: string;
  routeName?: string;
  routeColor?: string;
  destination?: string;
  directionName?: string;
  tripId?: string;
  latitude: number;
  longitude: number;
  bearing?: number;
  speedMps?: number;
  reportedAt?: string;
  fetchedAt: string;
  delaySeconds?: number;
  nextStopName?: string;
  nextStopEta?: string;
  riderCount?: number;
  capacity?: number;
}

/** `TransitDataSource`: an external API with its access rules and last call outcome. */
export interface TransitDataSource {
  id: string;
  displayName: string;
  vendor: string;
  category: DataSourceCategory;
  endpoint?: string;
  credentialField?: string;
  status: DataSourceStatus;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastRecordCount?: number;
  lastLatencyMs?: number;
  minRefreshSeconds?: number;
  rateLimitNote?: string;
  docsUrl?: string;
  phase?: number;
  notes?: string;
}

/** `TransitFeed.LiveSnapshot`: result of `TransitFeed.refreshLive`. */
export interface LiveSnapshot {
  vehicles?: TransitVehicle[];
  sources?: TransitDataSource[];
  serverTime: string;
}

/** `TransitFeed.StopEta`: one upcoming stop of a vehicle. */
export interface StopEta {
  stopId?: string;
  stopName: string;
  latitude?: number;
  longitude?: number;
  eta?: string;
  isRealtime?: boolean;
}

/** `TransitFeed.VehicleDetail`: result of `TransitFeed.vehicleDetail`. */
export interface VehicleDetail {
  vehicle: TransitVehicle;
  /** Path the vehicle's current trip follows, with its ordered stops. */
  path?: TransitRoutePath;
  upcomingStops?: StopEta[];
  predictionSource?: string;
  note?: string;
  fetchedAt: string;
}

/** `TransitFeed.Arrival`: one predicted arrival at a stop. */
export interface Arrival {
  provider: TransitProvider;
  routeCode?: string;
  routeName?: string;
  routeColor?: string;
  destination?: string;
  vehicleId?: string;
  vehicleLabel?: string;
  eta: string;
  isRealtime?: boolean;
}

/** `TransitFeed.StopArrivals`: result of `TransitFeed.stopArrivals`. */
export interface StopArrivals {
  stop: TransitStop;
  arrivals?: Arrival[];
  predictionSource?: string;
  note?: string;
  fetchedAt: string;
}

/** `TransitGeocoder.Place`: one location search result. */
export interface GeoPlace {
  label: string;
  detail?: string;
  latitude: number;
  longitude: number;
  kind: 'STOP' | 'PLACE';
  stopId?: string;
}

/** `TransitServiceAlert`: an operator-issued service alert. */
export interface ServiceAlert {
  id: string;
  provider: TransitProvider;
  headline: string;
  description?: string;
  cause?: string;
  effect?: string;
  url?: string;
  routeCodes?: string[];
  stopIds?: string[];
  activeStart?: string;
  activeEnd?: string;
  fetchedAt: string;
}

/** Map viewport bounds in degrees. */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** `TransitFeed.TripPlan.Leg.Mode`. */
export type TripLegMode = 'WALK' | 'BUS' | 'RAIL' | 'SHUTTLE';

/** `TransitFeed.TripPlan.Leg`: one walk or ride of a trip option. */
export interface TripLeg {
  mode: TripLegMode;
  fromName?: string;
  toName?: string;
  fromLatitude?: number;
  fromLongitude?: number;
  toLatitude?: number;
  toLongitude?: number;
  departAt?: string;
  arriveAt?: string;
  durationSeconds?: number;
  distanceMeters?: number;
  route?: C3Ref;
  routeCode?: string;
  routeColor?: string;
  headsign?: string;
  boardStop?: C3Ref;
  alightStop?: C3Ref;
  stopCount?: number;
  tripId?: string;
  vehicleLabel?: string;
  isRealtime?: boolean;
  isArrivalScheduled?: boolean;
  isEstimated?: boolean;
  encodedPolyline?: string;
}

/** `TransitFeed.TripPlan.Option.Kind`. */
export type TripOptionKind = 'WALK' | 'PRT' | 'CMU_SHUTTLE';

/** `TransitFeed.TripPlan.Option`: one way to make the trip. */
export interface TripOption {
  kind: TripOptionKind;
  summary: string;
  departAt: string;
  arriveAt: string;
  totalSeconds: number;
  walkSeconds?: number;
  walkMeters?: number;
  waitSeconds?: number;
  transfers?: number;
  isRealtime?: boolean;
  legs?: TripLeg[];
  alerts?: ServiceAlert[];
}

/** `TransitFeed.TripPlan`: result of `TransitFeed.planTrip`. */
export interface TripPlan {
  options?: TripOption[];
  notes?: string[];
  plannedAt: string;
  /** Earliest departure the plan used (the requested time, or now). */
  departAt: string;
  /** Every route with a stop near both ends, for the route picker. */
  servingRoutes?: TransitRoute[];
}

/** `TransitFeed.TripPlan.Spec`: what `TransitFeed.planTrip` plans. */
export interface TripPlanSpec {
  fromLatitude: number;
  fromLongitude: number;
  toLatitude: number;
  toLongitude: number;
  /** ISO instant; omit to leave now. */
  departAt?: string;
  /** Restrict to these TransitRoute ids. */
  routeIds?: string[];
}

/** A trip endpoint chosen in the UI. */
export interface TripEndpoint {
  label: string;
  detail?: string;
  latitude: number;
  longitude: number;
  /** `campus` = the default CMU origin, `me` = browser location. */
  kind: 'campus' | 'me' | 'place' | 'stop';
}

/** `TransitFeed.RouteTrip.Status`. */
export type RouteTripStatus = 'RUNNING' | 'UPCOMING';

/** `TransitFeed.RouteTrip`: one running or upcoming trip of a route. */
export interface RouteTrip {
  provider: TransitProvider;
  routeId: string;
  routeCode?: string;
  routeColor?: string;
  /** Pass to `TransitFeed.tripTimetable` with `routeId` and `serviceDate`. */
  tripId: string;
  serviceDate?: string;
  headsign?: string;
  directionName?: string;
  status: RouteTripStatus;
  startAt: string;
  endAt: string;
  firstStopName?: string;
  lastStopName?: string;
  stopCount?: number;
  isRealtime?: boolean;
  vehicleId?: string;
  vehicleLabel?: string;
  delaySeconds?: number;
  nextStopName?: string;
  nextStopAt?: string;
}

/** `TransitFeed.RouteTrips`: result of `TransitFeed.routeTrips`. */
export interface RouteTrips {
  trips?: RouteTrip[];
  windowStart: string;
  windowEnd: string;
  notes?: string[];
  fetchedAt: string;
}

/** `TransitFeed.TripTimetable.Stop`: one stop of a trip with its times. */
export interface TripTimetableStop {
  stopId?: string;
  stopName: string;
  latitude?: number;
  longitude?: number;
  scheduledAt?: string;
  expectedAt?: string;
  isRealtime?: boolean;
  passed?: boolean;
  skipped?: boolean;
}

/** `TransitFeed.TripTimetable`: result of `TransitFeed.tripTimetable`. */
export interface TripTimetable {
  trip: RouteTrip;
  stops?: TripTimetableStop[];
  note?: string;
  fetchedAt: string;
}
