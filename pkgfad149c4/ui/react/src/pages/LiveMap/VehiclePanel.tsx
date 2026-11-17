/*
 * Panel for a selected vehicle: where it is going and its next stops first, technical details on request.
 */
import React, { useEffect, useState } from 'react';
import { Bus, Info, MapPinned, Route as RouteIcon } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { PanelHeader } from '@/components/app/MapSheet';
import { Disclosure, EmptyState, Fact, Notice, SectionTitle, SkeletonList, Tag } from '@/components/app/Surface';
import { PredictionBadge, ProviderBadge, RouteChip } from '@/components/transit/TransitBits';
import { fetchVehicleDetail } from '@/api/transit';
import { TransitRoutePath, TransitVehicle, VehicleDetail } from '@/Interfaces';
import {
  ageSeconds,
  compassDirection,
  formatAge,
  formatClock,
  formatDelay,
  formatMinutes,
  minutesUntil,
  mph,
  PROVIDER_LABEL,
  STALE_FIX_SECONDS,
} from '@/lib/transit';

const DETAIL_REFRESH_MS = 30000;

interface VehiclePanelProps {
  vehicleId: string;
  /** Latest row from the live snapshot; undefined once the vehicle leaves the operator feed. */
  liveVehicle?: TransitVehicle;
  clockOffsetMs: number;
  now: number;
  routeShown: boolean;
  onToggleRoute: () => void;
  onSelectStop: (stopId: string) => void;
  /** Reports the path of the vehicle's current trip so the map can show only that route's stops. */
  onPathLoaded: (path: TransitRoutePath | null) => void;
  onClose: () => void;
  closeLabel?: string;
}

export default function VehiclePanel({
  vehicleId,
  liveVehicle,
  clockOffsetMs,
  now,
  routeShown,
  onToggleRoute,
  onSelectStop,
  onPathLoaded,
  onClose,
  closeLabel,
}: VehiclePanelProps) {
  const [detail, setDetail] = useState<VehicleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setDetail(null);
    setLoading(true);
    const load = async () => {
      try {
        const d = await fetchVehicleDetail(vehicleId);
        if (cancelled) return;
        setDetail(d);
        onPathLoaded(d.path ?? null);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(load, DETAIL_REFRESH_MS);
        }
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // onPathLoaded is a stable callback from the page; re-running on it would refetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);

  const v = liveVehicle ?? detail?.vehicle;
  const fixAge = ageSeconds(v?.reportedAt, clockOffsetMs, now);
  const staleFix = fixAge != null && fixAge > STALE_FIX_SECONDS;
  const heading = compassDirection(v?.bearing);
  const speed = mph(v?.speedMps);
  const delay = formatDelay(v?.delaySeconds);
  const lateMins = v?.delaySeconds != null ? Math.round(v.delaySeconds / 60) : 0;

  const title = v ? (v.inService ? v.destination ?? v.routeName ?? 'In service' : 'Not in service') : 'Vehicle';

  return (
    <div className="flex flex-col gap-5">
      <PanelHeader
        eyebrow={
          <>
            {v && <ProviderBadge provider={v.provider} />}
            {v?.inService && <RouteChip code={v.routeCode} color={v.routeColor} />}
          </>
        }
        title={v?.inService && v.destination ? `To ${title}` : title}
        subtitle={v?.inService && v.routeName && v.routeName !== v.destination ? v.routeName : undefined}
        onClose={onClose}
        closeLabel={closeLabel}
      />

      {v && (delay || staleFix) && (
        <div className="flex flex-wrap gap-2">
          {delay && (
            <Tag tone={lateMins >= 3 ? 'peach' : 'mint'} icon={<Bus aria-hidden="true" />}>
              {delay}
            </Tag>
          )}
          {staleFix && <Tag tone="peach">GPS {formatAge(fixAge)}</Tag>}
        </div>
      )}

      {!liveVehicle && detail && (
        <Notice tone="warning" title="No longer reporting">
          The operator stopped reporting this vehicle. Its last known details are shown.
        </Notice>
      )}

      {v?.inService && v.route && (
        <AppButton
          variant={routeShown ? 'soft' : 'secondary'}
          icon={<RouteIcon />}
          onClick={onToggleRoute}
          aria-pressed={routeShown}
          fullWidth
        >
          {routeShown ? 'Showing route & stops' : 'Show route & stops'}
        </AppButton>
      )}

      <section aria-labelledby="veh-next" className="flex flex-col gap-2">
        <SectionTitle id="veh-next">Next stops</SectionTitle>
        {loading && !detail && (
          <>
            <p role="status" className="sr-only">
              Loading next stops
            </p>
            <SkeletonList count={2} />
          </>
        )}
        {error && (
          <Notice tone="error" title="Next stops are unavailable">
            {error}
          </Notice>
        )}
        {detail && !(detail.upcomingStops?.length) && (
          <EmptyState compact icon={<MapPinned />} tone="lavender" title="No upcoming stops">
            {detail.note ?? 'The operator has not published predictions for this vehicle.'}
          </EmptyState>
        )}
        {detail?.note && !!detail.upcomingStops?.length && <p className="text-base text-ink-soft">{detail.note}</p>}
        {detail?.upcomingStops && detail.upcomingStops.length > 0 && (
          <ol className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line">
            {detail.upcomingStops.map((s, i) => {
              const mins = minutesUntil(s.eta, clockOffsetMs, now);
              const content = (
                <>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-base font-medium text-ink [overflow-wrap:anywhere]">{s.stopName}</span>
                    <span>
                      <PredictionBadge realtime={s.isRealtime} />
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end">
                    <span className="text-lg font-bold text-ink">{formatMinutes(mins)}</span>
                    <span className="text-base text-ink-soft">{formatClock(s.eta)}</span>
                  </span>
                </>
              );
              return (
                <li key={`${s.stopId ?? s.stopName}-${i}`}>
                  {s.stopId ? (
                    <button
                      type="button"
                      onClick={() => onSelectStop(s.stopId as string)}
                      className="flex min-h-16 w-full items-center gap-3 bg-surface px-4 py-3 text-left hover:bg-surface-2"
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="flex min-h-16 items-center gap-3 bg-surface px-4 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {v && (
        <Disclosure icon={<Info />} title="Vehicle details">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Fact label={v.provider === 'PRT' ? 'Vehicle number' : 'Shuttle'}>{v.vehicleLabel}</Fact>
            <Fact label="Heading">{heading ? `${heading} (${Math.round(v.bearing ?? 0)}°)` : 'Not reported'}</Fact>
            <Fact label="Speed">{speed ?? 'Not reported'}</Fact>
            <Fact label="Last GPS">{formatAge(fixAge)}</Fact>
            {v.directionName && <Fact label="Direction">{v.directionName}</Fact>}
            {delay && <Fact label="Schedule">{delay}</Fact>}
            {v.riderCount != null && <Fact label="Boardings this ride">{v.riderCount}</Fact>}
            {v.capacity != null && <Fact label="Capacity">{v.capacity} seats</Fact>}
          </dl>
          <p className="mt-4 text-base text-ink-soft">
            Source: {detail?.predictionSource ?? PROVIDER_LABEL[v.provider]}. Position updated{' '}
            {formatAge(ageSeconds(v.fetchedAt, clockOffsetMs, now))}. “Live” times come from vehicle tracking;
            “Scheduled” times come from the timetable.
          </p>
        </Disclosure>
      )}
    </div>
  );
}
