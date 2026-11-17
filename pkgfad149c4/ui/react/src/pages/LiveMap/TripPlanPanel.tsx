/*
 * Directions panel: plans trips from an origin to the chosen destination and compares the options.
 * The headline of each option (total time, arrival, how) is visible at a glance; steps open when it is chosen.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Bus,
  ChevronDown,
  Footprints,
  Info,
  Pencil,
  RefreshCw,
  Route as RouteIcon,
  TrainFront,
  TriangleAlert,
} from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { SegmentedControl } from '@/components/app/Controls';
import { PanelHeader } from '@/components/app/MapSheet';
import { Disclosure, EmptyState, Notice, SkeletonList, Tag } from '@/components/app/Surface';
import PlaceAutocomplete, { QuickChoice } from '@/components/transit/PlaceAutocomplete';
import { PredictionBadge, RouteChip } from '@/components/transit/TransitBits';
import { CAMPUS_ORIGIN, planTrip } from '@/api/transit';
import { GeoPlace, TripEndpoint, TripLeg, TripOption, TripPlan } from '@/Interfaces';
import { formatClock, optionKey } from '@/lib/transit';
import { cn } from '@/lib/utils';

type SortKey = 'arrival' | 'walking' | 'reliable';

/** Plans go stale quickly because departures are live predictions. */
const REPLAN_MS = 90000;

function mins(seconds?: number): string {
  if (seconds == null) return '—';
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

function meters(m?: number): string {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function LegIcon({ leg, className }: { leg: TripLeg; className?: string }) {
  const cls = cn('size-5 shrink-0', className);
  if (leg.mode === 'WALK') return <Footprints className={cls} aria-hidden="true" />;
  if (leg.mode === 'RAIL') return <TrainFront className={cls} aria-hidden="true" />;
  return <Bus className={cls} aria-hidden="true" />;
}

function rideNoun(leg?: TripLeg): string {
  if (!leg) return 'vehicle';
  return leg.mode === 'SHUTTLE' ? 'shuttle' : leg.mode === 'RAIL' ? 'train' : 'bus';
}

/** One-line plain summary for screen readers: "Walk 4 min, then bus 61C, then walk 3 min". */
function legsSummary(o: TripOption): string {
  return (o.legs ?? [])
    .map((l) => (l.mode === 'WALK' ? `walk ${mins(l.durationSeconds)}` : `${rideNoun(l)} ${l.routeCode ?? ''}`.trim()))
    .join(', then ');
}

interface TripPlanPanelProps {
  origin: TripEndpoint;
  destination: TripEndpoint;
  locating: boolean;
  onOriginChange: (origin: TripEndpoint) => void;
  onUseMyLocation: () => void;
  onOptionChange: (option: TripOption | null) => void;
  onMonitorVehicle: (leg: TripLeg) => void;
  onClose: () => void;
}

export default function TripPlanPanel({
  origin,
  destination,
  locating,
  onOriginChange,
  onUseMyLocation,
  onOptionChange,
  onMonitorVehicle,
  onClose,
}: TripPlanPanelProps) {
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('arrival');
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setLoading(true);
      try {
        const p = await planTrip(origin, destination);
        if (cancelled) return;
        setPlan(p);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, REPLAN_MS);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [origin, destination, tick]);

  const sorted = useMemo(() => {
    const opts = [...(plan?.options ?? [])];
    const arrival = (o: TripOption) => new Date(o.arriveAt).getTime();
    if (sortKey === 'walking') opts.sort((a, b) => (a.walkMeters ?? 0) - (b.walkMeters ?? 0) || arrival(a) - arrival(b));
    else if (sortKey === 'reliable')
      opts.sort(
        (a, b) =>
          Number(!!b.isRealtime || b.kind === 'WALK') - Number(!!a.isRealtime || a.kind === 'WALK') ||
          (a.alerts?.length ?? 0) - (b.alerts?.length ?? 0) ||
          arrival(a) - arrival(b),
      );
    else opts.sort((a, b) => arrival(a) - arrival(b));
    return opts;
  }, [plan, sortKey]);

  // Keep the chosen option across re-plans; default to the earliest arrival.
  const selected = useMemo(() => {
    const opts = plan?.options ?? [];
    return (
      opts.find((o) => optionKey(o) === selectedKey) ??
      [...opts].sort((a, b) => new Date(a.arriveAt).getTime() - new Date(b.arriveAt).getTime())[0] ??
      null
    );
  }, [plan, selectedKey]);

  useEffect(() => {
    onOptionChange(selected);
  }, [selected, onOptionChange]);

  const fastestSeconds = useMemo(() => Math.min(...(plan?.options ?? []).map((o) => o.totalSeconds), Infinity), [plan]);
  const earliestKey = useMemo(() => {
    const first = [...(plan?.options ?? [])].sort((a, b) => new Date(a.arriveAt).getTime() - new Date(b.arriveAt).getTime())[0];
    return first ? optionKey(first) : null;
  }, [plan]);

  const quickChoices: QuickChoice[] = [
    { id: 'me', label: 'My location', detail: 'Use this device’s location', icon: 'me', onChoose: onUseMyLocation },
    { id: 'campus', label: CAMPUS_ORIGIN.label, detail: CAMPUS_ORIGIN.detail, icon: 'campus', onChoose: () => onOriginChange(CAMPUS_ORIGIN) },
  ];

  const pickOrigin = (place: GeoPlace) => {
    onOriginChange({
      label: place.label,
      detail: place.detail,
      latitude: place.latitude,
      longitude: place.longitude,
      kind: place.kind === 'STOP' ? 'stop' : 'place',
    });
    setEditingOrigin(false);
  };

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        eyebrow={<Tag tone="sky" icon={<RouteIcon aria-hidden="true" />}>Directions to</Tag>}
        title={destination.label}
        subtitle={destination.detail}
        onClose={onClose}
      />

      {/* Starting point (the destination is the panel title) */}
      <div className="flex flex-col gap-3 rounded-card bg-surface-2 p-3">
        {editingOrigin ? (
          <div className="flex flex-col gap-2">
            <PlaceAutocomplete
              label="Start from"
              placeholder="Address, place, or stop"
              onSelect={pickOrigin}
              quickChoices={quickChoices.map((q) => ({
                ...q,
                onChoose: () => {
                  q.onChoose();
                  setEditingOrigin(false);
                },
              }))}
              autoFocus
            />
            <AppButton variant="ghost" onClick={() => setEditingOrigin(false)} className="self-start">
              Cancel
            </AppButton>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface text-ink-soft" aria-hidden="true">
              <span className="size-3 rounded-full border-[3px] border-ink" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-base text-ink-soft">From</span>
              <span className="truncate text-base font-semibold text-ink">{locating ? 'Finding your location…' : origin.label}</span>
            </div>
            <AppButton variant="secondary" icon={<Pencil />} onClick={() => setEditingOrigin(true)} className="px-3">
              Change<span className="sr-only"> starting point</span>
            </AppButton>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-base text-ink-soft" aria-live="polite">
            {loading && plan ? 'Updating…' : `Leaving now${plan ? ` · as of ${formatClock(plan.plannedAt)}` : ''}`}
          </p>
          <AppButton variant="ghost" icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading && !!plan} className="-mr-2 px-3">
            Update
          </AppButton>
        </div>
        <SegmentedControl<SortKey>
          label="Sort options by"
          value={sortKey}
          onChange={setSortKey}
          options={[
            { value: 'arrival', label: 'Fastest' },
            { value: 'walking', label: 'Walk less' },
            { value: 'reliable', label: 'Reliable' },
          ]}
        />
      </div>

      {loading && !plan && !error && (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-base text-ink-soft">
            Finding the best ways to get there…
          </p>
          <SkeletonList count={3} />
        </div>
      )}
      {error && (
        <Notice
          tone="error"
          title="We couldn’t plan this trip"
          action={
            <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading}>
              Try again
            </AppButton>
          }
        >
          {error}
        </Notice>
      )}
      {plan && sorted.length === 0 && !loading && (
        <EmptyState
          compact
          icon={<RouteIcon />}
          tone="lavender"
          title="No trips found"
          action={
            <AppButton icon={<Pencil />} onClick={() => setEditingOrigin(true)}>
              Change start
            </AppButton>
          }
        >
          We couldn’t find a walking or transit option for this trip right now.
        </EmptyState>
      )}

      {sorted.length > 0 && (
        <ul className="flex flex-col gap-3" aria-label="Trip options">
          {sorted.map((o) => {
            const key = optionKey(o);
            const isSelected = selected != null && key === optionKey(selected);
            const ride = o.legs?.find((l) => l.mode !== 'WALK');
            const extra = o.totalSeconds - fastestSeconds;
            const detailsId = `trip-steps-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
            return (
              <li
                key={key}
                className={cn(
                  'overflow-hidden rounded-card border transition-colors duration-150',
                  isSelected ? 'border-brand bg-surface shadow-soft' : 'border-line bg-surface',
                )}
              >
                <button
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  aria-expanded={isSelected}
                  aria-controls={detailsId}
                  className={cn('flex w-full flex-col gap-2 p-4 text-left', isSelected ? 'bg-tint-sky/60' : 'hover:bg-surface-2')}
                >
                  <span className="sr-only">
                    {mins(o.totalSeconds)}, arrive {formatClock(o.arriveAt)}: {legsSummary(o)}.
                  </span>
                  <span className="flex items-start justify-between gap-3" aria-hidden="true">
                    <span className="flex flex-col">
                      <span className="text-2xl font-bold leading-tight text-ink">{mins(o.totalSeconds)}</span>
                      <span className="text-base text-ink-soft">
                        {formatClock(o.departAt)} – {formatClock(o.arriveAt)}
                      </span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      {key === earliestKey && (o.legs?.length ?? 0) > 0 && <Tag tone="mint">Arrives first</Tag>}
                      {extra > 60 && <span className="text-base text-ink-soft">+{mins(extra)}</span>}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-base text-ink" aria-hidden="true">
                    {(o.legs ?? []).map((leg, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <ArrowRight className="size-4 text-ink-soft" />}
                        {leg.mode === 'WALK' ? (
                          <span className="inline-flex items-center gap-1 text-ink-soft">
                            <LegIcon leg={leg} /> {mins(leg.durationSeconds)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5">
                            <LegIcon leg={leg} className="text-ink-soft" />
                            <RouteChip code={leg.routeCode} color={leg.routeColor} />
                          </span>
                        )}
                      </React.Fragment>
                    ))}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-base text-ink-soft">
                      Walk {mins(o.walkSeconds)}
                      {o.kind !== 'WALK' && o.waitSeconds != null ? ` · wait ${mins(o.waitSeconds)}` : ''}
                    </span>
                    {ride && <PredictionBadge realtime={ride.isRealtime} />}
                    {o.alerts && o.alerts.length > 0 && (
                      <Tag tone="peach" icon={<TriangleAlert aria-hidden="true" />}>
                        {o.alerts.length} alert{o.alerts.length > 1 ? 's' : ''}
                      </Tag>
                    )}
                    {!isSelected && (
                      <span className="ml-auto inline-flex items-center gap-1 font-semibold text-brand">
                        Steps <ChevronDown className="size-4" aria-hidden="true" />
                      </span>
                    )}
                  </span>
                </button>

                <div id={detailsId} hidden={!isSelected}>
                  {isSelected && (
                    <div className="flex flex-col gap-4 border-t border-line p-4">
                      <ol className="flex flex-col">
                        {(o.legs ?? []).map((leg, i) => {
                          const last = i === (o.legs?.length ?? 0) - 1;
                          return (
                            <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                              {!last && <span className="absolute left-[1.0625rem] top-10 h-[calc(100%-2.5rem)] w-0.5 bg-line-strong" aria-hidden="true" />}
                              <span
                                className={cn(
                                  'flex size-9 shrink-0 items-center justify-center rounded-full',
                                  leg.mode === 'WALK' ? 'bg-surface-2 text-ink-soft' : 'bg-tint-sky text-tint-sky-ink',
                                )}
                                aria-hidden="true"
                              >
                                <LegIcon leg={leg} />
                              </span>
                              <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
                                {leg.mode === 'WALK' ? (
                                  <>
                                    <span className="text-base font-semibold text-ink">
                                      Walk {mins(leg.durationSeconds)}
                                      <span className="font-normal text-ink-soft"> · {meters(leg.distanceMeters)}</span>
                                    </span>
                                    <span className="text-base text-ink-soft">
                                      To {last ? destination.label : leg.toName} · {formatClock(leg.departAt)} – {formatClock(leg.arriveAt)}
                                    </span>
                                    {leg.isEstimated && <span className="text-base text-ink-soft">Distance is a straight-line estimate.</span>}
                                  </>
                                ) : (
                                  <>
                                    <span className="flex flex-wrap items-center gap-1.5 text-base font-semibold text-ink">
                                      Take the {rideNoun(leg)} <RouteChip code={leg.routeCode} color={leg.routeColor} />
                                    </span>
                                    {leg.headsign && <span className="text-base text-ink-soft">Toward {leg.headsign}</span>}
                                    <span className="text-base text-ink">
                                      Board at <span className="font-medium">{leg.fromName}</span> at {formatClock(leg.departAt)}
                                    </span>
                                    <span className="text-base text-ink">
                                      Ride {leg.stopCount} stops ({mins(leg.durationSeconds)}), get off at{' '}
                                      <span className="font-medium">{leg.toName}</span> at {formatClock(leg.arriveAt)}
                                    </span>
                                    {leg.isArrivalScheduled && (
                                      <span className="text-base text-ink-soft">Arrival time is from the timetable.</span>
                                    )}
                                    <span className="mt-1 flex flex-wrap items-center gap-2">
                                      <PredictionBadge realtime={leg.isRealtime} />
                                      {leg.vehicleLabel && <span className="text-base text-ink-soft">Vehicle {leg.vehicleLabel}</span>}
                                    </span>
                                    {leg.vehicleLabel && (
                                      <AppButton icon={<Bus />} onClick={() => onMonitorVehicle(leg)} className="mt-2 self-start">
                                        Track this {rideNoun(leg)}
                                      </AppButton>
                                    )}
                                  </>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                      {o.alerts && o.alerts.length > 0 && (
                        <Notice tone="warning" title={o.alerts.length > 1 ? 'Service alerts on this route' : 'Service alert on this route'}>
                          <ul className="flex flex-col gap-2">
                            {o.alerts.map((a) => (
                              <li key={a.id}>
                                {a.headline}
                                {a.url && (
                                  <>
                                    {' '}
                                    <a href={a.url} target="_blank" rel="noreferrer" className="font-semibold underline underline-offset-2">
                                      Read more<span className="sr-only"> (opens in a new tab)</span>
                                    </a>
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        </Notice>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Disclosure icon={<Info />} title="About these results">
        <div className="flex flex-col gap-2 text-base text-ink-soft">
          {plan?.notes && plan.notes.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5">
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p>
            Options use one bus or shuttle with walking at each end. Departure times are operator predictions (“Live” means
            a tracked vehicle). Walking paths come from OpenStreetMap; sidewalk conditions are not checked yet.
          </p>
        </div>
      </Disclosure>
    </div>
  );
}
