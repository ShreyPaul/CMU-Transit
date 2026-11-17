/*
 * Live map page: real-time PRT and CMU shuttle vehicles, stops, and route paths around CMU and Pittsburgh, plus trip
 * planning to a searched address.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { MapSheet, PanelHeader } from '@/components/app/MapSheet';
import { Disclosure } from '@/components/app/Surface';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import {
  CAMPUS_ORIGIN,
  fetchCampusStops,
  fetchPaths,
  fetchRoutes,
  fetchStop,
  fetchStopsByIds,
  fetchStopsInBounds,
} from '@/api/transit';
import { useLiveVehicles, useNow } from '@/hooks/useLiveVehicles';
import {
  GeoPlace,
  MapBounds,
  TransitRoute,
  TransitRoutePath,
  TransitStop,
  TripEndpoint,
  TripLeg,
  TripOption,
} from '@/Interfaces';
import { decodePolyline, optionKey, STOP_MIN_ZOOM } from '@/lib/transit';
import { cn } from '@/lib/utils';
import ControlPanel, { LayerState } from './ControlPanel';
import MapSearchCard from './MapSearchCard';
import RouteTripsPanel from './RouteTripsPanel';
import StopPanel from './StopPanel';
import TransitMap, { DrawnPath, MapTarget, TripLegLine } from './TransitMap';
import TripPlanPanel from './TripPlanPanel';
import VehiclePanel from './VehiclePanel';

type Selection =
  | { kind: 'vehicle'; id: string }
  | { kind: 'stop'; id: string }
  | { kind: 'trip' }
  | { kind: 'routeTrips' }
  | null;

const DEFAULT_LAYERS: LayerState = { prt: true, cmu: true, outOfService: false, stops: true, cmuPaths: true };
const FALLBACK_PATH_COLOR = '#6b7280';

function myLocationEndpoint(loc: { lat: number; lng: number }): TripEndpoint {
  return { label: 'My location', latitude: loc.lat, longitude: loc.lng, kind: 'me' };
}

const WELCOME_KEY = 'cmu-transit.welcome-dismissed';

function readWelcomeDismissed(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

export default function LiveMapPage() {
  const { reportError } = useErrorBoundary();
  const { snapshot, clockOffsetMs, loading, error, refresh } = useLiveVehicles();
  const now = useNow(5000);

  const [routes, setRoutes] = useState<TransitRoute[]>([]);
  const [campusRouteIds, setCampusRouteIds] = useState<string[]>([]);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [focusedRouteIds, setFocusedRouteIds] = useState<string[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [showSelectedRoute, setShowSelectedRoute] = useState(true);
  const [monitoredPath, setMonitoredPath] = useState<TransitRoutePath | null>(null);
  const [viewport, setViewport] = useState<{ bounds: MapBounds; zoom: number } | null>(null);
  const [viewportStops, setViewportStops] = useState<TransitStop[]>([]);
  const [focusStops, setFocusStops] = useState<TransitStop[]>([]);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [pathCache, setPathCache] = useState<Record<string, TransitRoutePath[]>>({});
  const [target, setTarget] = useState<MapTarget | null>(null);
  const [searchPin, setSearchPin] = useState<{ lat: number; lng: number; label: string } | null>(null);
  const [myLocation, setMyLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !readWelcomeDismissed());
  const [origin, setOrigin] = useState<TripEndpoint>(CAMPUS_ORIGIN);
  const [destination, setDestination] = useState<TripEndpoint | null>(null);
  const [tripOption, setTripOption] = useState<TripOption | null>(null);
  /** True when the open vehicle or stop was opened from the route trip list, so Back returns to that list. */
  const [returnToTrips, setReturnToTrips] = useState(false);
  const knownStops = useRef(new Map<string, TransitStop>());

  const tripMode = selection?.kind === 'trip' && destination != null;

  // Network metadata: all routes once, plus which routes serve the campus.
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchRoutes(), fetchCampusStops()])
      .then(([allRoutes, campusStops]) => {
        if (cancelled) return;
        setRoutes(allRoutes);
        const byProviderCode = new Map(allRoutes.map((r) => [`${r.provider}:${r.routeCode}`, r.id]));
        const ids = new Set<string>();
        campusStops.forEach((s) =>
          (s.servedRouteCodes ?? []).forEach((code) => {
            const id = byProviderCode.get(`${s.provider}:${code}`);
            if (id) ids.add(id);
          }),
        );
        setCampusRouteIds(Array.from(ids));
      })
      .catch((err) => {
        if (!cancelled) reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const allVehicles = useMemo(() => snapshot?.vehicles ?? [], [snapshot]);
  const vehicleById = useMemo(() => new Map(allVehicles.map((v) => [v.id, v])), [allVehicles]);
  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const selectedVehicle = selection?.kind === 'vehicle' ? vehicleById.get(selection.id) : undefined;
  const tripRide = useMemo(() => tripOption?.legs?.find((l) => l.mode !== 'WALK') ?? null, [tripOption]);

  // A monitored vehicle shows only its own trip's path and stops.
  const monitoring = selection?.kind === 'vehicle' && showSelectedRoute && !!selectedVehicle?.inService;
  useEffect(() => setMonitoredPath(null), [selection]);

  // CMU shuttle routes with at least one vehicle in service right now.
  const runningCmuRouteIds = useMemo(() => {
    const ids = new Set<string>();
    allVehicles.forEach((v) => {
      if (v.provider === 'CMU_SHUTTLE' && v.inService && v.route?.id) ids.add(v.route.id);
    });
    return Array.from(ids);
  }, [allVehicles]);
  const runningCmuCodes = useMemo(
    () => new Set(runningCmuRouteIds.map((id) => routeById.get(id)?.routeCode).filter((c): c is string => !!c)),
    [runningCmuRouteIds, routeById],
  );

  // Routes whose geometry is needed: focused routes, the monitored vehicle's route, and the running CMU routes.
  const selectedRouteId = monitoring ? selectedVehicle?.route?.id : undefined;
  const showCmuNetwork = layers.cmuPaths && layers.cmu && !tripMode && !monitoring;
  const pathRouteIds = useMemo(() => {
    const ids = new Set<string>(tripMode ? [] : focusedRouteIds);
    if (selectedRouteId) ids.add(selectedRouteId);
    if (showCmuNetwork) runningCmuRouteIds.forEach((id) => ids.add(id));
    return Array.from(ids);
  }, [focusedRouteIds, selectedRouteId, showCmuNetwork, runningCmuRouteIds, tripMode]);

  useEffect(() => {
    const missing = pathRouteIds.filter((id) => !(id in pathCache));
    if (!missing.length) return;
    let cancelled = false;
    fetchPaths(missing)
      .then((paths) => {
        if (cancelled) return;
        setPathCache((prev) => {
          const next = { ...prev };
          missing.forEach((id) => (next[id] = []));
          paths.forEach((p) => next[p.route.id].push(p));
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [pathRouteIds, pathCache, reportError]);

  const drawnPaths: DrawnPath[] = useMemo(() => {
    const emphasized = new Set<string>(focusedRouteIds);
    if (selectedRouteId) emphasized.add(selectedRouteId);
    return pathRouteIds.flatMap((id) => {
      const color = routeById.get(id)?.color || FALLBACK_PATH_COLOR;
      // The monitored vehicle's route draws only the path its current trip follows, once that is known.
      const paths = id === selectedRouteId && monitoredPath && !focusedRouteIds.includes(id) ? [monitoredPath] : pathCache[id] ?? [];
      return paths.map((path) => ({ path, color, emphasized: emphasized.has(id) }));
    });
  }, [pathRouteIds, pathCache, routeById, focusedRouteIds, selectedRouteId, monitoredPath]);

  // Which stops to draw: the trip's boarding/alighting stops, the stops on tracked/focused routes, or the viewport.
  const stopMode: 'trip' | 'route' | 'viewport' = tripMode ? 'trip' : monitoring || focusedRouteIds.length ? 'route' : 'viewport';
  const focusStopIds = useMemo(() => {
    const ids = new Set<string>();
    if (stopMode === 'trip') {
      if (tripRide?.boardStop) ids.add(tripRide.boardStop.id);
      if (tripRide?.alightStop) ids.add(tripRide.alightStop.id);
    } else if (stopMode === 'route') {
      if (monitoring) (monitoredPath?.stopSequence ?? []).forEach((id) => ids.add(id));
      focusedRouteIds.forEach((rid) => (pathCache[rid] ?? []).forEach((p) => (p.stopSequence ?? []).forEach((id) => ids.add(id))));
    }
    return Array.from(ids).sort();
  }, [stopMode, tripRide, monitoring, monitoredPath, focusedRouteIds, pathCache]);
  const focusKey = focusStopIds.join('|');

  useEffect(() => {
    if (stopMode === 'viewport') return;
    let cancelled = false;
    const missing = focusStopIds.filter((id) => !knownStops.current.has(id));
    const finish = () => setFocusStops(focusStopIds.map((id) => knownStops.current.get(id)).filter((s): s is TransitStop => !!s));
    if (!missing.length) {
      finish();
      return;
    }
    setStopsLoading(true);
    fetchStopsByIds(missing)
      .then((rows) => {
        if (cancelled) return;
        rows.forEach((s) => knownStops.current.set(s.id, s));
        finish();
      })
      .catch((err) => {
        if (!cancelled) reportError(err);
      })
      .finally(() => {
        if (!cancelled) setStopsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // focusKey captures focusStopIds by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopMode, focusKey, reportError]);

  // Stops inside the viewport once zoomed in far enough; debounced and capped.
  useEffect(() => {
    if (stopMode !== 'viewport' || !viewport || !layers.stops || viewport.zoom < STOP_MIN_ZOOM) {
      setViewportStops([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setStopsLoading(true);
      try {
        const rows = await fetchStopsInBounds(viewport.bounds, 400);
        if (cancelled) return;
        rows.forEach((s) => knownStops.current.set(s.id, s));
        setViewportStops(rows);
      } catch (err) {
        if (!cancelled) reportError(err);
      } finally {
        if (!cancelled) setStopsLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [viewport, layers.stops, stopMode, reportError]);

  const visibleVehicles = useMemo(
    () =>
      allVehicles.filter((v) => {
        if (v.id === selectedVehicle?.id) return true;
        if (v.provider === 'PRT' && !layers.prt) return false;
        if (v.provider === 'CMU_SHUTTLE' && !layers.cmu) return false;
        // While a transit option is shown, only vehicles on its route stay on the map.
        if (tripMode && tripRide?.route) return !!v.inService && v.route?.id === tripRide.route.id;
        if (!v.inService) return layers.outOfService && focusedRouteIds.length === 0;
        if (focusedRouteIds.length > 0) return !!v.route && focusedRouteIds.includes(v.route.id);
        return true;
      }),
    [allVehicles, layers, focusedRouteIds, selectedVehicle, tripMode, tripRide],
  );

  const mapStops = useMemo(() => {
    let visible: TransitStop[];
    if (stopMode === 'viewport') {
      // CMU stops are shown only for running routes; idle on-demand zones have hundreds of virtual stops.
      visible = viewportStops.filter((s) =>
        s.provider === 'PRT' ? layers.prt : layers.cmu && (s.servedRouteCodes ?? []).some((c) => runningCmuCodes.has(c)),
      );
    } else {
      visible = stopMode === 'trip' || layers.stops ? focusStops : [];
    }
    if (selection?.kind === 'stop' && !visible.some((s) => s.id === selection.id)) {
      const s = knownStops.current.get(selection.id);
      if (s) return [...visible, s];
    }
    return visible;
  }, [stopMode, viewportStops, focusStops, layers.prt, layers.cmu, layers.stops, selection, runningCmuCodes]);

  const tripLines: TripLegLine[] = useMemo(() => {
    if (!tripMode || !tripOption) return [];
    return (tripOption.legs ?? [])
      .filter((l) => l.encodedPolyline)
      .map((l, i) => ({
        key: `${optionKey(tripOption)}-${i}`,
        points: decodePolyline(l.encodedPolyline as string),
        color: l.routeColor,
        walking: l.mode === 'WALK',
      }));
  }, [tripMode, tripOption]);

  // Frame the whole trip when a different option is chosen (not on every re-plan of the same option).
  const framedOption = useRef<string | null>(null);
  useEffect(() => {
    if (!tripMode || !tripOption) {
      framedOption.current = null;
      return;
    }
    const key = optionKey(tripOption);
    if (framedOption.current === key) return;
    framedOption.current = key;
    const pts = tripLines.flatMap((l) => l.points);
    if (destination) pts.push([destination.latitude, destination.longitude]);
    pts.push([origin.latitude, origin.longitude]);
    const lats = pts.map((p) => p[0]);
    const lngs = pts.map((p) => p[1]);
    setTarget({
      lat: 0,
      lng: 0,
      bounds: [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)],
      nonce: Date.now(),
    });
  }, [tripMode, tripOption, tripLines, destination, origin]);

  const onViewportChange = useCallback((bounds: MapBounds, zoom: number) => setViewport({ bounds, zoom }), []);

  const selectVehicle = useCallback(
    (id: string) => {
      setSelection({ kind: 'vehicle', id });
      setReturnToTrips(false);
      setOptionsOpen(false);
      setShowSelectedRoute(true);
      const v = vehicleById.get(id);
      if (v) setTarget({ lat: v.latitude, lng: v.longitude, nonce: Date.now() });
    },
    [vehicleById],
  );

  const selectStop = useCallback(
    (id: string) => {
      setSelection({ kind: 'stop', id });
      setReturnToTrips(false);
      setOptionsOpen(false);
      const cached = knownStops.current.get(id);
      if (cached) {
        setTarget({ lat: cached.latitude, lng: cached.longitude, zoom: 17, nonce: Date.now() });
        return;
      }
      fetchStop(id)
        .then((s) => {
          if (!s) return;
          knownStops.current.set(s.id, s);
          setTarget({ lat: s.latitude, lng: s.longitude, zoom: 17, nonce: Date.now() });
        })
        .catch(reportError);
    },
    [reportError],
  );

  const locate = useCallback(
    (onFound?: (loc: { lat: number; lng: number }) => void) => {
      if (!navigator.geolocation) {
        reportError(new Error('This browser does not support location access.'));
        return;
      }
      setLocating(true);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          setMyLocation(loc);
          setLocating(false);
          if (onFound) onFound(loc);
          else setTarget({ ...loc, zoom: 16, nonce: Date.now() });
        },
        (err) => {
          setLocating(false);
          reportError(new Error(`Could not get your location: ${err.message}`));
        },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    },
    [reportError],
  );

  const startTrip = useCallback(
    (dest: TripEndpoint) => {
      setDestination(dest);
      setTripOption(null);
      setSearchPin({ lat: dest.latitude, lng: dest.longitude, label: dest.label });
      // Plan from the user's location when they have shared it and kept the default campus origin.
      if (myLocation) setOrigin((o) => (o.kind === 'campus' ? myLocationEndpoint(myLocation) : o));
      setSelection({ kind: 'trip' });
      setOptionsOpen(false);
    },
    [myLocation],
  );

  const onPlaceChosen = useCallback(
    (place: GeoPlace) => {
      if (place.kind === 'STOP' && place.stopId) {
        setSearchPin(null);
        selectStop(place.stopId);
        setOptionsOpen(false);
        return;
      }
      startTrip({ label: place.label, detail: place.detail, latitude: place.latitude, longitude: place.longitude, kind: 'place' });
    },
    [selectStop, startTrip],
  );

  const onDirectionsToStop = useCallback(
    (stop: TransitStop) =>
      startTrip({
        label: stop.stopName,
        detail: stop.stopCode ? `Stop #${stop.stopCode}` : undefined,
        latitude: stop.latitude,
        longitude: stop.longitude,
        kind: 'stop',
      }),
    [startTrip],
  );

  const onMonitorVehicle = useCallback(
    (leg: TripLeg) => {
      const provider = leg.mode === 'SHUTTLE' ? 'CMU_SHUTTLE' : 'PRT';
      const match = allVehicles.find((v) => v.provider === provider && v.vehicleLabel === leg.vehicleLabel);
      if (match) selectVehicle(match.id);
      else reportError(new Error(`Vehicle ${leg.vehicleLabel} is not reporting a position right now.`));
    },
    [allVehicles, selectVehicle, reportError],
  );

  const closeTrip = useCallback(() => {
    setSelection(null);
    setDestination(null);
    setTripOption(null);
    setSearchPin(null);
  }, []);

  const toggleRoute = useCallback((routeId: string) => {
    setFocusedRouteIds((prev) => (prev.includes(routeId) ? prev.filter((id) => id !== routeId) : [...prev, routeId]));
  }, []);

  const showRouteTrips = useCallback(() => {
    setSelection({ kind: 'routeTrips' });
    setReturnToTrips(false);
    setOptionsOpen(false);
  }, []);

  // Vehicles and stops opened from the trip list come back to it on Back.
  const selectVehicleFromTrips = useCallback(
    (id: string) => {
      selectVehicle(id);
      setReturnToTrips(true);
    },
    [selectVehicle],
  );
  const selectStopFromTrips = useCallback(
    (id: string) => {
      selectStop(id);
      setReturnToTrips(true);
    },
    [selectStop],
  );

  // The trip list only makes sense while routes are focused.
  useEffect(() => {
    if (focusedRouteIds.length > 0) return;
    setReturnToTrips(false);
    setSelection((s) => (s?.kind === 'routeTrips' ? null : s));
  }, [focusedRouteIds.length]);

  const liveVehicleIds = useMemo(() => new Set(allVehicles.map((v) => v.id)), [allVehicles]);

  const searchNear: [number, number] = myLocation ? [myLocation.lat, myLocation.lng] : [origin.latitude, origin.longitude];

  const inService = allVehicles.filter((v) => v.inService);
  const prtLive = inService.filter((v) => v.provider === 'PRT').length;
  const cmuLive = inService.filter((v) => v.provider === 'CMU_SHUTTLE').length;

  const dismissWelcome = useCallback(() => {
    setShowWelcome(false);
    try {
      window.localStorage.setItem(WELCOME_KEY, '1');
    } catch {
      // Storage can be unavailable (private mode); the card simply shows again next visit.
    }
  }, []);

  const controlPanel = (
    <ControlPanel
      sources={snapshot?.sources ?? []}
      vehicles={allVehicles}
      routes={routes}
      campusRouteIds={campusRouteIds}
      focusedRouteIds={focusedRouteIds}
      layers={layers}
      zoom={viewport?.zoom ?? 15}
      stopMinZoom={STOP_MIN_ZOOM}
      stopsLoading={stopsLoading}
      clockOffsetMs={clockOffsetMs}
      now={now}
      routeStopsMode={stopMode === 'route'}
      onLayersChange={setLayers}
      onToggleRoute={toggleRoute}
      onClearRoutes={() => setFocusedRouteIds([])}
      onShowTrips={showRouteTrips}
    />
  );

  const closeSelection = () => {
    if (returnToTrips && focusedRouteIds.length > 0) {
      setReturnToTrips(false);
      setSelection({ kind: 'routeTrips' });
      return;
    }
    setReturnToTrips(false);
    setSelection(destination ? { kind: 'trip' } : null);
  };
  const closeLabel = destination || (returnToTrips && focusedRouteIds.length > 0) ? 'Back' : undefined;
  const sheetOpen = selection != null || optionsOpen;

  return (
    <div className="relative h-full w-full overflow-hidden">
      <TransitMap
        vehicles={visibleVehicles}
        stops={mapStops}
        paths={tripMode ? [] : drawnPaths}
        selectedVehicleId={selection?.kind === 'vehicle' ? selection.id : null}
        selectedStopId={selection?.kind === 'stop' ? selection.id : null}
        searchPin={searchPin}
        myLocation={myLocation}
        tripLines={tripLines}
        tripOrigin={tripMode && origin.kind !== 'me' ? { lat: origin.latitude, lng: origin.longitude, label: origin.label } : null}
        target={target}
        clockOffsetMs={clockOffsetMs}
        now={now}
        onSelectVehicle={selectVehicle}
        onSelectStop={selectStop}
        onViewportChange={onViewportChange}
      />

      {/* Search + live status (top on phones; left column with options on desktop). Hidden on phones while a sheet is open. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-[1100] flex flex-col gap-3 p-3 sm:mx-auto sm:max-w-xl',
          'lg:bottom-4 lg:left-4 lg:right-auto lg:top-4 lg:mx-0 lg:w-[24rem] lg:max-w-none lg:p-0',
          sheetOpen && 'max-lg:hidden',
        )}
      >
        <MapSearchCard
          showWelcome={showWelcome}
          onDismissWelcome={dismissWelcome}
          prtLive={prtLive}
          cmuLive={cmuLive}
          sources={snapshot?.sources ?? []}
          error={error}
          loading={loading}
          hasSnapshot={snapshot != null}
          clockOffsetMs={clockOffsetMs}
          now={now}
          locating={locating}
          searchNear={searchNear}
          onPlaceChosen={onPlaceChosen}
          onLocate={() => locate()}
          onRefresh={refresh}
          onOpenOptions={() => {
            setSelection(null);
            setOptionsOpen(true);
          }}
        />
        <div className="pointer-events-auto hidden min-h-0 overflow-y-auto rounded-card border border-line bg-surface shadow-float lg:block">
          <Disclosure
            title="Map options"
            icon={<SlidersHorizontal />}
            defaultOpen
            className="rounded-card border-0"
          >
            {controlPanel}
          </Disclosure>
        </div>
      </div>

      {optionsOpen && !selection && (
        <MapSheet label="Map options" placement="left" onClose={() => setOptionsOpen(false)} className="lg:hidden">
          <div className="flex flex-col gap-4">
            <PanelHeader title="Map options" subtitle="Choose what the map shows." onClose={() => setOptionsOpen(false)} closeLabel="Done" />
            {controlPanel}
          </div>
        </MapSheet>
      )}

      {selection && (
        <MapSheet
          key={selection.kind === 'trip' || selection.kind === 'routeTrips' ? selection.kind : `${selection.kind}:${selection.id}`}
          label={
            selection.kind === 'vehicle'
              ? 'Vehicle details'
              : selection.kind === 'stop'
                ? 'Stop details'
                : selection.kind === 'routeTrips'
                  ? 'Route trips'
                  : 'Directions'
          }
          onClose={selection.kind === 'trip' ? closeTrip : closeSelection}
        >
          {selection.kind === 'vehicle' && (
            <VehiclePanel
              key={selection.id}
              vehicleId={selection.id}
              liveVehicle={selectedVehicle}
              clockOffsetMs={clockOffsetMs}
              now={now}
              routeShown={showSelectedRoute}
              onToggleRoute={() => setShowSelectedRoute((s) => !s)}
              onSelectStop={selectStop}
              onPathLoaded={setMonitoredPath}
              onClose={closeSelection}
              closeLabel={closeLabel}
            />
          )}
          {selection.kind === 'stop' && (
            <StopPanel
              key={selection.id}
              stopId={selection.id}
              knownStop={knownStops.current.get(selection.id)}
              clockOffsetMs={clockOffsetMs}
              now={now}
              onSelectVehicle={selectVehicle}
              onDirections={onDirectionsToStop}
              onClose={closeSelection}
              closeLabel={closeLabel}
            />
          )}
          {selection.kind === 'routeTrips' && focusedRouteIds.length > 0 && (
            <RouteTripsPanel
              routeIds={focusedRouteIds}
              routes={routes}
              liveVehicleIds={liveVehicleIds}
              clockOffsetMs={clockOffsetMs}
              now={now}
              onSelectVehicle={selectVehicleFromTrips}
              onSelectStop={selectStopFromTrips}
              onClose={closeSelection}
            />
          )}
          {selection.kind === 'trip' && destination && (
            <TripPlanPanel
              origin={origin}
              destination={destination}
              locating={locating}
              onOriginChange={setOrigin}
              onUseMyLocation={() => locate((loc) => setOrigin(myLocationEndpoint(loc)))}
              onOptionChange={setTripOption}
              onMonitorVehicle={onMonitorVehicle}
              onClose={closeTrip}
            />
          )}
        </MapSheet>
      )}
    </div>
  );
}
