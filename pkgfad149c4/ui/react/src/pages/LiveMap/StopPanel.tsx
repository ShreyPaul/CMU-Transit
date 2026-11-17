/*
 * Panel for a selected stop: directions and the next arrivals first, stop details on request.
 */
import React, { useEffect, useState } from 'react';
import { CalendarClock, Info, Navigation, RefreshCw } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { PanelHeader } from '@/components/app/MapSheet';
import { Disclosure, EmptyState, Notice, SectionTitle, SkeletonList, Tag } from '@/components/app/Surface';
import { PredictionBadge, ProviderBadge, RouteChip } from '@/components/transit/TransitBits';
import { fetchStopArrivals } from '@/api/transit';
import { StopArrivals, TransitStop } from '@/Interfaces';
import { ageSeconds, formatAge, formatClock, formatMinutes, minutesUntil } from '@/lib/transit';

const ARRIVALS_REFRESH_MS = 30000;

interface StopPanelProps {
  stopId: string;
  /** Stop row from the map cache, shown while arrivals load. */
  knownStop?: TransitStop;
  clockOffsetMs: number;
  now: number;
  onSelectVehicle: (vehicleId: string) => void;
  onDirections: (stop: TransitStop) => void;
  onClose: () => void;
  closeLabel?: string;
}

export default function StopPanel({
  stopId,
  knownStop,
  clockOffsetMs,
  now,
  onSelectVehicle,
  onDirections,
  onClose,
  closeLabel,
}: StopPanelProps) {
  const [data, setData] = useState<StopArrivals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    const load = async () => {
      try {
        const d = await fetchStopArrivals(stopId);
        if (cancelled) return;
        setData(d);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, ARRIVALS_REFRESH_MS);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [stopId, tick]);

  useEffect(() => setData(null), [stopId]);

  const stop = data?.stop ?? knownStop;
  const arrivals = data?.arrivals ?? [];

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        eyebrow={
          <>
            {stop && <ProviderBadge provider={stop.provider} />}
            {stop?.stopCode && <Tag>Stop #{stop.stopCode}</Tag>}
          </>
        }
        title={stop?.stopName ?? 'Stop'}
        subtitle={stop?.servedRouteCodes?.length ? `Routes ${stop.servedRouteCodes.join(', ')}` : undefined}
        onClose={onClose}
        closeLabel={closeLabel}
      />

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <AppButton variant="primary" icon={<Navigation />} onClick={() => stop && onDirections(stop)} disabled={!stop}>
          Directions here
        </AppButton>
        <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading && !!data}>
          Refresh
        </AppButton>
      </div>

      <section aria-labelledby="stop-next" className="flex flex-col gap-2">
        <SectionTitle id="stop-next">Next arrivals</SectionTitle>
        {loading && !data && (
          <>
            <p role="status" className="sr-only">
              Loading arrivals
            </p>
            <SkeletonList count={2} />
          </>
        )}
        {error && (
          <Notice
            tone="error"
            title="Arrivals are unavailable"
            action={
              <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)}>
                Try again
              </AppButton>
            }
          >
            {error}
          </Notice>
        )}
        {data && arrivals.length === 0 && (
          <EmptyState compact icon={<CalendarClock />} tone="lavender" title="No arrivals soon">
            {data.note ?? 'Nothing is predicted to stop here in the next while. Check back later.'}
          </EmptyState>
        )}
        {data?.note && arrivals.length > 0 && <p className="text-base text-ink-soft">{data.note}</p>}
        {arrivals.length > 0 && (
          <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line">
            {arrivals.map((a, i) => {
              const mins = minutesUntil(a.eta, clockOffsetMs, now);
              const body = (
                <>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <RouteChip code={a.routeCode} color={a.routeColor} />
                    <span className="text-base text-ink-soft [overflow-wrap:anywhere]">
                      {a.destination ? `To ${a.destination}` : a.routeName ?? ''}
                    </span>
                    <span>
                      <PredictionBadge realtime={a.isRealtime} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="text-lg font-bold text-ink">{formatMinutes(mins)}</span>
                    <span className="text-base text-ink-soft">{formatClock(a.eta)}</span>
                  </span>
                </>
              );
              return (
                <li key={`${a.routeCode}-${a.eta}-${i}`}>
                  {a.vehicleId ? (
                    <button
                      type="button"
                      onClick={() => onSelectVehicle(a.vehicleId as string)}
                      aria-label={`${a.routeCode ?? ''} ${a.destination ? `to ${a.destination}` : ''}, ${formatMinutes(mins)}. Show this vehicle.`}
                      className="flex min-h-16 w-full items-center gap-3 bg-surface px-4 py-3 text-left hover:bg-surface-2"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex min-h-16 items-center gap-3 bg-surface px-4 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {arrivals.some((a) => a.vehicleId) && <p className="text-base text-ink-soft">Tap an arrival to follow that vehicle.</p>}
      </section>

      {data && (
        <Disclosure icon={<Info />} title="About these times">
          <p className="text-base text-ink-soft">
            Source: {data.predictionSource}, updated {formatAge(ageSeconds(data.fetchedAt, clockOffsetMs, now))}. “Live” times
            follow a tracked vehicle; “Scheduled” times are timetable estimates.
          </p>
        </Disclosure>
      )}
    </div>
  );
}
