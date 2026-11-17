/*
 * The first thing riders see on the map: what the app does, where to search, and how fresh the live data is.
 */
import React from 'react';
import { LocateFixed, RefreshCw, SlidersHorizontal, TriangleAlert } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { Notice } from '@/components/app/Surface';
import PlaceAutocomplete from '@/components/transit/PlaceAutocomplete';
import { GeoPlace, TransitDataSource } from '@/Interfaces';
import { formatAge, freshestFeedAge, liveFeedIssues } from '@/lib/transit';
import { cn } from '@/lib/utils';

interface MapSearchCardProps {
  showWelcome: boolean;
  onDismissWelcome: () => void;
  prtLive: number;
  cmuLive: number;
  sources: TransitDataSource[];
  error: string | null;
  loading: boolean;
  hasSnapshot: boolean;
  clockOffsetMs: number;
  now: number;
  locating: boolean;
  searchNear: [number, number];
  onPlaceChosen: (place: GeoPlace) => void;
  onLocate: () => void;
  onRefresh: () => void;
  onOpenOptions: () => void;
}

export default function MapSearchCard({
  showWelcome,
  onDismissWelcome,
  prtLive,
  cmuLive,
  sources,
  error,
  loading,
  hasSnapshot,
  clockOffsetMs,
  now,
  locating,
  searchNear,
  onPlaceChosen,
  onLocate,
  onRefresh,
  onOpenOptions,
}: MapSearchCardProps) {
  const issues = liveFeedIssues(sources, clockOffsetMs, now);
  const updated = freshestFeedAge(sources, clockOffsetMs, now);

  return (
    <section
      aria-label="Search and live status"
      className="pointer-events-auto flex flex-col gap-3 rounded-card border border-line bg-surface p-3 shadow-float sm:p-4"
    >
      {showWelcome ? (
        <div className="flex flex-col gap-2 rounded-control bg-tint-sky p-3 text-tint-sky-ink">
          <h1 className="text-xl font-bold leading-snug">Get around CMU</h1>
          <p className="text-base">
            Live PRT buses and CMU shuttles. Search where you’re going, or tap a bus or stop.
          </p>
          <AppButton variant="primary" onClick={onDismissWelcome} className="self-start">
            Got it
          </AppButton>
        </div>
      ) : (
        <h1 className="sr-only">CMU Transit live map</h1>
      )}

      <PlaceAutocomplete
        label="Where to?"
        placeholder="Address, place, or stop"
        near={searchNear}
        onSelect={onPlaceChosen}
        clearOnSelect
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
        <AppButton icon={<LocateFixed />} onClick={onLocate} loading={locating}>
          {locating ? 'Locating…' : 'Near me'}
        </AppButton>
        <AppButton icon={<SlidersHorizontal />} onClick={onOpenOptions} className="lg:hidden">
          Options
        </AppButton>
      </div>

      {error ? (
        <Notice
          tone="error"
          title="Can’t reach the live feed"
          action={
            <AppButton variant="secondary" icon={<RefreshCw />} onClick={onRefresh} loading={loading}>
              Try again
            </AppButton>
          }
        >
          {error}
        </Notice>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="flex min-w-0 items-center gap-2 text-base text-ink" aria-live="polite">
            {hasSnapshot ? (
              <>
                <span
                  className={cn('app-live-dot size-2.5 shrink-0 rounded-full', issues.length ? 'bg-tint-peach-ink' : 'bg-tint-mint-ink')}
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="font-semibold">{prtLive} PRT</span> · <span className="font-semibold">{cmuLive} shuttles</span>
                  <span className="text-ink-soft"> · {formatAge(updated)}</span>
                </span>
              </>
            ) : (
              <span className="text-ink-soft">Loading live vehicles…</span>
            )}
          </p>
          <AppButton variant="ghost" icon={<RefreshCw />} onClick={onRefresh} loading={loading && hasSnapshot} className="-mr-1 px-3">
            Refresh
          </AppButton>
        </div>
      )}

      {!error && issues.length > 0 && (
        <p role="status" className="flex items-start gap-2 rounded-control bg-tint-peach px-3 py-2 text-base text-tint-peach-ink">
          <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <span>
            {issues.length === 1 ? `${issues[0].label} positions` : 'Live positions'} may be a few minutes old.
          </span>
        </p>
      )}
    </section>
  );
}
