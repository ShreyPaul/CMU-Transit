/*
 * Map options: which layers to draw, which routes to focus on, and (tucked away) live feed details.
 * Rendered in a bottom sheet on phones and tablets, and in the left column on desktop.
 */
import React, { useMemo } from 'react';
import { Check, Info, ListOrdered, Radio, X } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { SelectField, ToggleRow } from '@/components/app/Controls';
import { Disclosure, SectionTitle } from '@/components/app/Surface';
import { RouteChip, StatusBadge } from '@/components/transit/TransitBits';
import { TransitDataSource, TransitRoute, TransitVehicle } from '@/Interfaces';
import { ageSeconds, formatAge, LIVE_SOURCE_LABEL, liveFeedIssues } from '@/lib/transit';
import { cn } from '@/lib/utils';

export interface LayerState {
  prt: boolean;
  cmu: boolean;
  outOfService: boolean;
  stops: boolean;
  cmuPaths: boolean;
}

interface ControlPanelProps {
  sources: TransitDataSource[];
  vehicles: TransitVehicle[];
  routes: TransitRoute[];
  campusRouteIds: string[];
  focusedRouteIds: string[];
  layers: LayerState;
  zoom: number;
  stopMinZoom: number;
  stopsLoading: boolean;
  clockOffsetMs: number;
  now: number;
  /** True while a vehicle is monitored or routes are focused, so only those routes' stops are drawn. */
  routeStopsMode: boolean;
  onLayersChange: (layers: LayerState) => void;
  onToggleRoute: (routeId: string) => void;
  onClearRoutes: () => void;
  /** Opens the list of every trip of the focused routes in the next 3 hours. */
  onShowTrips: () => void;
}

export default function ControlPanel(props: ControlPanelProps) {
  const {
    sources,
    vehicles,
    routes,
    campusRouteIds,
    focusedRouteIds,
    layers,
    zoom,
    stopMinZoom,
    stopsLoading,
    clockOffsetMs,
    now,
    routeStopsMode,
    onLayersChange,
    onToggleRoute,
    onClearRoutes,
    onShowTrips,
  } = props;

  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);

  const countsByRoute = useMemo(() => {
    const m = new Map<string, number>();
    vehicles.forEach((v) => {
      if (v.inService && v.route?.id) m.set(v.route.id, (m.get(v.route.id) ?? 0) + 1);
    });
    return m;
  }, [vehicles]);

  const cmuRoutes = useMemo(
    () =>
      routes
        .filter((r) => r.provider === 'CMU_SHUTTLE')
        .sort((a, b) => (countsByRoute.get(b.id) ?? 0) - (countsByRoute.get(a.id) ?? 0) || a.routeCode.localeCompare(b.routeCode)),
    [routes, countsByRoute],
  );
  const runningCmuRoutes = cmuRoutes.filter((r) => countsByRoute.get(r.id) || focusedRouteIds.includes(r.id));
  const idleCmuRoutes = cmuRoutes.filter((r) => !runningCmuRoutes.includes(r));
  const prtCampusRoutes = useMemo(
    () =>
      campusRouteIds
        .map((id) => routeById.get(id))
        .filter((r): r is TransitRoute => !!r && r.provider === 'PRT')
        .sort((a, b) => a.routeCode.localeCompare(b.routeCode, undefined, { numeric: true })),
    [campusRouteIds, routeById],
  );
  const prtRoutes = useMemo(
    () =>
      routes
        .filter((r) => r.provider === 'PRT')
        .sort((a, b) => a.routeCode.localeCompare(b.routeCode, undefined, { numeric: true })),
    [routes],
  );
  const otherFocusedPrt = focusedRouteIds
    .filter((id) => !campusRouteIds.includes(id))
    .map((id) => routeById.get(id))
    .filter((r): r is TransitRoute => !!r && r.provider === 'PRT');

  const issues = liveFeedIssues(sources, clockOffsetMs, now);

  const renderChip = (r: TransitRoute) => {
    const active = focusedRouteIds.includes(r.id);
    const count = countsByRoute.get(r.id) ?? 0;
    return (
      <li key={r.id}>
        <button
          type="button"
          onClick={() => onToggleRoute(r.id)}
          aria-pressed={active}
          title={r.longName}
          className={cn(
            'inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 transition-colors duration-150',
            active ? 'border-brand bg-tint-sky text-tint-sky-ink' : 'border-line-strong bg-surface hover:bg-surface-2',
          )}
        >
          {active && <Check className="size-4 shrink-0" aria-hidden="true" />}
          <RouteChip code={r.routeCode} color={r.color} className={active ? 'text-tint-sky-ink' : undefined} />
          <span className="text-base text-ink-soft" aria-hidden="true">
            {count}
          </span>
          <span className="sr-only">
            , {count} running{r.longName ? `, ${r.longName}` : ''}
          </span>
        </button>
      </li>
    );
  };

  const stopsHint = routeStopsMode
    ? stopsLoading
      ? 'Loading route stops…'
      : 'Only stops on the routes you picked'
    : zoom < stopMinZoom
      ? 'Zoom in closer to see stops'
      : stopsLoading
        ? 'Loading stops…'
        : 'Tap a stop to see arrivals';

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="opt-layers" className="flex flex-col gap-1">
        <SectionTitle id="opt-layers">Show on map</SectionTitle>
        <div className="-mx-2 flex flex-col">
          <ToggleRow
            label="PRT buses & trains"
            hint="Blue tags show the route"
            leading={<span className="tv-legend tv-legend-prt">61C</span>}
            checked={layers.prt}
            onChange={(prt) => onLayersChange({ ...layers, prt })}
          />
          <ToggleRow
            label="CMU shuttles"
            hint="Red circles"
            leading={<span className="tv-legend tv-legend-cmu">A</span>}
            checked={layers.cmu}
            onChange={(cmu) => onLayersChange({ ...layers, cmu })}
          />
          <ToggleRow
            label="Stops"
            hint={stopsHint}
            leading={<span className="tv-legend tv-legend-stop" />}
            checked={layers.stops}
            onChange={(stops) => onLayersChange({ ...layers, stops })}
          />
          <ToggleRow
            label="Shuttle routes"
            hint="Lines for shuttles running now"
            leading={<span className="tv-legend tv-legend-line" />}
            checked={layers.cmuPaths}
            onChange={(cmuPaths) => onLayersChange({ ...layers, cmuPaths })}
          />
          <ToggleRow
            label="Parked vehicles"
            hint="Gray dots, not carrying riders"
            leading={<span className="tv-legend tv-legend-out" />}
            checked={layers.outOfService}
            onChange={(outOfService) => onLayersChange({ ...layers, outOfService })}
          />
        </div>
      </section>

      <section aria-labelledby="opt-routes" className="flex flex-col gap-3">
        <SectionTitle
          id="opt-routes"
          action={
            focusedRouteIds.length > 0 ? (
              <AppButton variant="ghost" icon={<X />} onClick={onClearRoutes} className="-mr-2 px-3">
                Clear ({focusedRouteIds.length})
              </AppButton>
            ) : undefined
          }
        >
          Focus on routes
        </SectionTitle>
        <p className="-mt-2 text-base text-ink-soft">
          Pick routes to see only their vehicles and paths. The number is how many are running now.
        </p>

        {focusedRouteIds.length > 0 && (
          <AppButton variant="primary" icon={<ListOrdered />} onClick={onShowTrips} fullWidth>
            {focusedRouteIds.length === 1
              ? `${routeById.get(focusedRouteIds[0])?.routeCode ?? 'Route'} trips in the next 3 hours`
              : `Trips for these ${focusedRouteIds.length} routes, next 3 hours`}
          </AppButton>
        )}

        {cmuRoutes.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-ink">CMU shuttles running now</h3>
            {runningCmuRoutes.length > 0 ? (
              <ul className="flex flex-wrap gap-2">{runningCmuRoutes.map(renderChip)}</ul>
            ) : (
              <p className="text-base text-ink-soft">No shuttle is running right now.</p>
            )}
            {idleCmuRoutes.length > 0 && (
              <Disclosure bare title={`${idleCmuRoutes.length} shuttle routes not running`}>
                <ul className="flex flex-wrap gap-2">{idleCmuRoutes.map(renderChip)}</ul>
              </Disclosure>
            )}
          </div>
        )}

        {prtCampusRoutes.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold text-ink">PRT routes near campus</h3>
            <ul className="flex flex-wrap gap-2">{prtCampusRoutes.map(renderChip)}</ul>
          </div>
        )}

        <SelectField
          id="add-prt-route"
          label="Add another PRT route"
          value=""
          onChange={(value) => {
            if (value && !focusedRouteIds.includes(value)) onToggleRoute(value);
          }}
        >
          <option value="">Choose a route…</option>
          {prtRoutes.map((r) => (
            <option key={r.id} value={r.id} disabled={focusedRouteIds.includes(r.id)}>
              {`${r.routeCode} ${r.longName ?? ''}`.trim()} ({countsByRoute.get(r.id) ?? 0} running)
            </option>
          ))}
        </SelectField>
        {otherFocusedPrt.length > 0 && <ul className="flex flex-wrap gap-2">{otherFocusedPrt.map(renderChip)}</ul>}
      </section>

      <div className="flex flex-col gap-2">
        <Disclosure icon={<Radio />} title={issues.length ? `Live feeds (${issues.length} delayed)` : 'Live feeds'}>
          <ul className="flex flex-col gap-3">
            {sources.map((s) => {
              const successAge = ageSeconds(s.lastSuccessAt, clockOffsetMs, now);
              const issue = issues.find((i) => i.id === s.id);
              return (
                <li key={s.id} className="flex flex-col gap-1 rounded-control bg-surface-2 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-base font-semibold text-ink">{LIVE_SOURCE_LABEL[s.id] ?? s.displayName}</span>
                    <StatusBadge status={s.status} />
                  </div>
                  <span className="text-base text-ink-soft">
                    Updated {formatAge(successAge)}
                    {s.lastRecordCount != null ? ` · ${s.lastRecordCount} vehicles` : ''}
                  </span>
                  {issue && <span className="text-base font-medium text-tint-peach-ink">{issue.message}</span>}
                  {s.status === 'ERROR' && s.lastError && <span className="text-base text-tint-rose-ink">{s.lastError}</span>}
                </li>
              );
            })}
            {sources.length === 0 && <li className="text-base text-ink-soft">Waiting for the first update…</li>}
          </ul>
        </Disclosure>
        <Disclosure icon={<Info />} title="About this map">
          <div className="flex flex-col gap-2 text-base text-ink-soft">
            <p>Positions refresh every 15 seconds from PRT and CMU TripShot. Nothing on this map is simulated.</p>
            <p>A faded, dashed marker means its GPS position is more than 3 minutes old.</p>
          </div>
        </Disclosure>
      </div>
    </div>
  );
}
