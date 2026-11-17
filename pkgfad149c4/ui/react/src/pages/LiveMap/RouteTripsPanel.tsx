/*
 * Every trip of the focused routes in the next 3 hours, grouped by route and direction. Each trip opens into its full
 * stop-by-stop timetable. Times are live predictions for tracked trips and timetable times otherwise.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Bus, CalendarClock, Check, ChevronDown, RefreshCw } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { PanelHeader } from '@/components/app/MapSheet';
import { EmptyState, Notice, SkeletonList, Tag } from '@/components/app/Surface';
import { PredictionBadge, RouteChip } from '@/components/transit/TransitBits';
import { fetchRouteTrips, fetchTripTimetable } from '@/api/transit';
import { RouteTrip, RouteTrips, TransitRoute, TripTimetable, TripTimetableStop } from '@/Interfaces';
import { ageSeconds, formatAge, formatClock, formatDelay, formatMinutes, minutesUntil } from '@/lib/transit';
import { cn } from '@/lib/utils';

const REFRESH_MS = 30000;
const HORIZON_MINUTES = 180;
/** Trips shown per direction before "Show more". */
const TRIPS_SHOWN = 6;

interface RouteTripsPanelProps {
  routeIds: string[];
  routes: TransitRoute[];
  /** Ids of vehicles currently on the map, so "Follow" is offered only for vehicles that can be shown. */
  liveVehicleIds: Set<string>;
  clockOffsetMs: number;
  now: number;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStop: (stopId: string) => void;
  onClose: () => void;
}

interface TripGroup {
  key: string;
  routeId: string;
  routeCode?: string;
  routeColor?: string;
  label: string;
  trips: RouteTrip[];
}

/** Where a trip is going: `Inbound-Downtown` → `Downtown`; shuttle loops that end where they start → `Loop`. */
function tripDestination(t: RouteTrip): string {
  const m = t.headsign?.match(/^(?:Inbound|Outbound)\s*-\s*(.+)$/i);
  if (m) return m[1];
  return t.headsign ?? t.lastStopName ?? t.directionName ?? 'Trip';
}

function groupLabel(t: RouteTrip): string {
  if (t.provider === 'CMU_SHUTTLE') {
    return t.firstStopName && t.firstStopName === t.lastStopName ? `Loop from ${t.firstStopName}` : t.directionName ?? 'Loop';
  }
  const dest = tripDestination(t);
  return t.directionName ? `${t.directionName} to ${dest}` : `To ${dest}`;
}

export default function RouteTripsPanel({
  routeIds,
  routes,
  liveVehicleIds,
  clockOffsetMs,
  now,
  onSelectVehicle,
  onSelectStop,
  onClose,
}: RouteTripsPanelProps) {
  const [data, setData] = useState<RouteTrips | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [routeFilter, setRouteFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const routeKey = routeIds.join('|');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const load = async () => {
      try {
        const d = await fetchRouteTrips(routeKey ? routeKey.split('|') : [], HORIZON_MINUTES);
        if (cancelled) return;
        setData(d);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, REFRESH_MS);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [routeKey, tick]);

  // A route removed from the focus list can no longer be the filter.
  useEffect(() => {
    if (routeFilter !== 'all' && !routeIds.includes(routeFilter)) setRouteFilter('all');
  }, [routeIds, routeFilter]);

  const routeById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const focusedRoutes = useMemo(
    () => routeIds.map((id) => routeById.get(id)).filter((r): r is TransitRoute => !!r),
    [routeIds, routeById],
  );

  const groups: TripGroup[] = useMemo(() => {
    const byKey = new Map<string, TripGroup>();
    (data?.trips ?? [])
      .filter((t) => routeFilter === 'all' || t.routeId === routeFilter)
      .forEach((t) => {
        const label = groupLabel(t);
        const key = `${t.routeId}|${label}`;
        const g = byKey.get(key) ?? { key, routeId: t.routeId, routeCode: t.routeCode, routeColor: t.routeColor, label, trips: [] };
        g.trips.push(t);
        byKey.set(key, g);
      });
    const order = new Map(routeIds.map((id, i) => [id, i]));
    return Array.from(byKey.values()).sort(
      (a, b) => (order.get(a.routeId) ?? 99) - (order.get(b.routeId) ?? 99) || a.label.localeCompare(b.label),
    );
  }, [data, routeFilter, routeIds]);

  const tripCount = groups.reduce((n, g) => n + g.trips.length, 0);
  const codes = focusedRoutes.map((r) => r.routeCode).join(', ');

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        eyebrow={
          <>
            {focusedRoutes.slice(0, 4).map((r) => (
              <RouteChip key={r.id} code={r.routeCode} color={r.color} />
            ))}
            {focusedRoutes.length > 4 && <Tag>+{focusedRoutes.length - 4} more</Tag>}
          </>
        }
        title="Trips in the next 3 hours"
        subtitle={codes ? `Only ${codes}. Open a trip to see its time at every stop.` : undefined}
        onClose={onClose}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-base text-ink-soft" aria-live="polite">
          {data ? `${tripCount} trip${tripCount === 1 ? '' : 's'} · updated ${formatAge(ageSeconds(data.fetchedAt, clockOffsetMs, now))}` : ' '}
        </span>
        <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading && !!data}>
          Refresh
        </AppButton>
      </div>

      {focusedRoutes.length > 1 && (
        <ul className="flex flex-wrap gap-2" aria-label="Show trips for">
          {[{ id: 'all', label: 'All routes', color: undefined as string | undefined }, ...focusedRoutes.map((r) => ({ id: r.id, label: r.routeCode, color: r.color }))].map(
            (opt) => {
              const active = routeFilter === opt.id;
              return (
                <li key={opt.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setRouteFilter(opt.id)}
                    className={cn(
                      'inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 transition-colors duration-150',
                      active ? 'border-brand bg-tint-sky text-tint-sky-ink' : 'border-line-strong bg-surface hover:bg-surface-2',
                    )}
                  >
                    {active && <Check className="size-4 shrink-0" aria-hidden="true" />}
                    {opt.id === 'all' ? (
                      <span className="text-base font-semibold">{opt.label}</span>
                    ) : (
                      <RouteChip code={opt.label} color={opt.color} className={active ? 'text-tint-sky-ink' : undefined} />
                    )}
                  </button>
                </li>
              );
            },
          )}
        </ul>
      )}

      {loading && !data && (
        <>
          <p role="status" className="sr-only">
            Loading trips
          </p>
          <SkeletonList count={3} />
        </>
      )}

      {error && (
        <Notice
          tone="error"
          title="Trips are unavailable"
          action={
            <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)}>
              Try again
            </AppButton>
          }
        >
          {error}
        </Notice>
      )}

      {data?.notes && data.notes.length > 0 && (
        <ul className="flex flex-col gap-1">
          {data.notes.map((n) => (
            <li key={n} className="text-base text-ink-soft">
              {n}
            </li>
          ))}
        </ul>
      )}

      {data && tripCount === 0 && (
        <EmptyState compact icon={<CalendarClock />} tone="lavender" title="No trips in the next 3 hours">
          {routeFilter === 'all' ? 'None of these routes is running or scheduled to start soon.' : 'This route has no trips in the window.'}
        </EmptyState>
      )}

      {groups.map((g) => {
        const all = showAll[g.key];
        const shown = all ? g.trips : g.trips.slice(0, TRIPS_SHOWN);
        const hidden = g.trips.length - shown.length;
        const headingId = `grp-${g.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        return (
          <section key={g.key} aria-labelledby={headingId} className="flex flex-col gap-2">
            <h3 id={headingId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold text-ink">
              <RouteChip code={g.routeCode} color={g.routeColor} />
              <span className="[overflow-wrap:anywhere]">{g.label}</span>
              <span className="font-normal text-ink-soft">
                · {g.trips.length} trip{g.trips.length === 1 ? '' : 's'}
              </span>
            </h3>
            <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line">
              {shown.map((t) => {
                const id = `${t.routeId}|${t.tripId}|${t.serviceDate ?? ''}`;
                return (
                  <TripRow
                    key={id}
                    trip={t}
                    expanded={expanded === id}
                    onToggle={() => setExpanded((e) => (e === id ? null : id))}
                    refreshKey={data?.fetchedAt ?? ''}
                    canFollow={!!t.vehicleId && liveVehicleIds.has(t.vehicleId)}
                    clockOffsetMs={clockOffsetMs}
                    now={now}
                    onSelectVehicle={onSelectVehicle}
                    onSelectStop={onSelectStop}
                  />
                );
              })}
            </ul>
            {(hidden > 0 || all) && g.trips.length > TRIPS_SHOWN && (
              <AppButton variant="ghost" onClick={() => setShowAll((s) => ({ ...s, [g.key]: !all }))} className="self-start">
                {all ? 'Show fewer' : `Show ${hidden} more`}
              </AppButton>
            )}
          </section>
        );
      })}

      {data && tripCount > 0 && (
        <p className="text-base text-ink-soft">
          “Live” trips follow a tracked vehicle; “Scheduled” trips use the published timetable and may change.
        </p>
      )}
    </div>
  );
}

interface TripRowProps {
  trip: RouteTrip;
  expanded: boolean;
  onToggle: () => void;
  /** Changes on every list refresh, so an open timetable refreshes with it. */
  refreshKey: string;
  canFollow: boolean;
  clockOffsetMs: number;
  now: number;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStop: (stopId: string) => void;
}

function TripRow({ trip: t, expanded, onToggle, refreshKey, canFollow, clockOffsetMs, now, onSelectVehicle, onSelectStop }: TripRowProps) {
  const running = t.status === 'RUNNING';
  const startMins = minutesUntil(t.startAt, clockOffsetMs, now);
  const delay = t.isRealtime ? formatDelay(t.delaySeconds) : null;
  const lateMins = t.delaySeconds != null ? Math.round(t.delaySeconds / 60) : 0;
  const detail = running
    ? t.nextStopName
      ? `Next: ${t.nextStopName} at ${formatClock(t.nextStopAt)}`
      : 'On the road'
    : `Leaves ${t.firstStopName ?? 'the first stop'} ${startMins != null && startMins > 0 ? `in ${formatMinutes(startMins)}` : 'now'}`;
  const bodyId = `trip-${t.tripId.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  return (
    <li className="bg-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="flex min-h-16 w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2"
      >
        <span className="flex w-20 shrink-0 flex-col">
          <span className="text-lg font-bold text-ink">{formatClock(t.startAt)}</span>
          <span className="text-base text-ink-soft">to {formatClock(t.endAt)}</span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-base font-medium text-ink [overflow-wrap:anywhere]">To {tripDestination(t)}</span>
          <span className="text-base text-ink-soft [overflow-wrap:anywhere]">{detail}</span>
          <span className="flex flex-wrap gap-1.5">
            <Tag tone={running ? 'sky' : 'neutral'}>{running ? 'Running' : 'Upcoming'}</Tag>
            <PredictionBadge realtime={t.isRealtime} />
            {delay && <Tag tone={lateMins >= 3 ? 'peach' : 'mint'}>{delay}</Tag>}
            {t.vehicleLabel && (
              <Tag icon={<Bus aria-hidden="true" />}>{t.provider === 'PRT' ? `Bus ${t.vehicleLabel}` : t.vehicleLabel}</Tag>
            )}
          </span>
        </span>
        <ChevronDown
          className={cn('mt-1 size-5 shrink-0 text-ink-soft transition-transform duration-150', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      <div id={bodyId} hidden={!expanded} className="border-t border-line bg-surface-2/40 px-4 pb-4 pt-3">
        {expanded && (
          <TripStops
            trip={t}
            refreshKey={refreshKey}
            canFollow={canFollow}
            clockOffsetMs={clockOffsetMs}
            now={now}
            onSelectVehicle={onSelectVehicle}
            onSelectStop={onSelectStop}
          />
        )}
      </div>
    </li>
  );
}

interface TripStopsProps {
  trip: RouteTrip;
  refreshKey: string;
  canFollow: boolean;
  clockOffsetMs: number;
  now: number;
  onSelectVehicle: (vehicleId: string) => void;
  onSelectStop: (stopId: string) => void;
}

function TripStops({ trip, refreshKey, canFollow, clockOffsetMs, now, onSelectVehicle, onSelectStop }: TripStopsProps) {
  const [data, setData] = useState<TripTimetable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPassed, setShowPassed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTripTimetable(trip)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
    // The trip identity plus the list refresh key decide when to reload; other trip fields change every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip.routeId, trip.tripId, trip.serviceDate, refreshKey]);

  const stops = data?.stops ?? [];
  const nextIndex = stops.findIndex((s) => !s.passed && !s.skipped);
  const passedCount = stops.filter((s) => s.passed).length;
  const visible = showPassed ? stops : stops.filter((s) => !s.passed);

  return (
    <div className="flex flex-col gap-3">
      {canFollow && trip.vehicleId && (
        <AppButton variant="soft" icon={<Bus />} onClick={() => onSelectVehicle(trip.vehicleId as string)} fullWidth>
          Follow {trip.provider === 'PRT' ? `bus ${trip.vehicleLabel ?? ''}` : trip.vehicleLabel ?? 'this shuttle'} on the map
        </AppButton>
      )}
      {!data && !error && (
        <p role="status" className="text-base text-ink-soft">
          Loading stop times…
        </p>
      )}
      {error && (
        <Notice tone="error" title="Stop times are unavailable">
          {error}
        </Notice>
      )}
      {data?.note && <p className="text-base text-ink-soft">{data.note}</p>}
      {passedCount > 0 && (
        <AppButton variant="ghost" onClick={() => setShowPassed((s) => !s)} className="self-start">
          {showPassed ? 'Hide stops already served' : `Show ${passedCount} stop${passedCount === 1 ? '' : 's'} already served`}
        </AppButton>
      )}
      {visible.length > 0 && (
        <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
          {visible.map((s) => {
            const idx = stops.indexOf(s);
            return (
              <TimetableStopRow
                key={`${s.stopId ?? s.stopName}-${idx}`}
                stop={s}
                isNext={idx === nextIndex}
                clockOffsetMs={clockOffsetMs}
                now={now}
                onSelectStop={onSelectStop}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

function TimetableStopRow({
  stop: s,
  isNext,
  clockOffsetMs,
  now,
  onSelectStop,
}: {
  stop: TripTimetableStop;
  isNext: boolean;
  clockOffsetMs: number;
  now: number;
  onSelectStop: (stopId: string) => void;
}) {
  const shownAt = s.expectedAt ?? s.scheduledAt;
  const slipMins =
    s.isRealtime && s.expectedAt && s.scheduledAt
      ? Math.round((new Date(s.expectedAt).getTime() - new Date(s.scheduledAt).getTime()) / 60000)
      : 0;
  const mins = !s.passed && !s.skipped ? minutesUntil(shownAt, clockOffsetMs, now) : null;
  const content = (
    <>
      <span className="flex w-5 shrink-0 justify-center pt-1" aria-hidden="true">
        {s.passed ? (
          <Check className="size-4 text-ink-soft" />
        ) : (
          <span className={cn('size-2.5 rounded-full', isNext ? 'bg-brand' : 'bg-line-strong')} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-base [overflow-wrap:anywhere]', s.passed || s.skipped ? 'text-ink-soft' : 'font-medium text-ink')}>
          {s.stopName}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {isNext && <Tag tone="sky">Next stop</Tag>}
          {s.skipped && <Tag tone="peach">Skipped</Tag>}
          {s.passed && <span className="sr-only">Already served.</span>}
          {!s.passed && !s.skipped && s.isRealtime && <PredictionBadge realtime />}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end">
        <span className={cn('text-base font-semibold', s.passed || s.skipped ? 'text-ink-soft' : 'text-ink')}>
          {s.skipped ? '—' : formatClock(shownAt)}
        </span>
        {slipMins !== 0 && s.scheduledAt && (
          <span className="text-sm text-ink-soft">
            <span className="sr-only">Scheduled </span>
            <s>{formatClock(s.scheduledAt)}</s>
          </span>
        )}
        {mins != null && mins >= 0 && mins < 60 && !s.passed && <span className="text-sm text-ink-soft">{formatMinutes(mins)}</span>}
      </span>
    </>
  );
  return (
    <li className={cn(isNext && 'bg-tint-sky/40')}>
      {s.stopId ? (
        <button
          type="button"
          onClick={() => onSelectStop(s.stopId as string)}
          className="flex min-h-12 w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-h-12 items-start gap-3 px-3 py-2.5">{content}</div>
      )}
    </li>
  );
}
