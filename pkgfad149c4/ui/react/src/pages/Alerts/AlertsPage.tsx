/*
 * Service alerts page: operator-issued detours, closures, and outages from the PRT GTFS-Realtime alert feed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, ExternalLink, RefreshCw, SearchX } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { SearchInput, ToggleRow } from '@/components/app/Controls';
import { Card, EmptyState, Notice, PageContainer, PageHeader, SkeletonList, Tag, Tone } from '@/components/app/Surface';
import { ProviderBadge } from '@/components/transit/TransitBits';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { fetchAlerts, fetchCampusStops } from '@/api/transit';
import { ServiceAlert } from '@/Interfaces';
import { formatAge } from '@/lib/transit';

const EFFECT_TONE: Record<string, Tone> = {
  NO_SERVICE: 'rose',
  DETOUR: 'peach',
  STOP_MOVED: 'peach',
  REDUCED_SERVICE: 'peach',
  SIGNIFICANT_DELAYS: 'peach',
  MODIFIED_SERVICE: 'lavender',
  ACCESSIBILITY_ISSUE: 'sky',
};

function humanize(value?: string): string {
  if (!value) return '';
  const s = value.toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const ALERT_POLL_MS = 120000;
/** Descriptions longer than this start collapsed behind "Show more". */
const LONG_DESCRIPTION = 180;

function AlertCard({ alert: a, campusRoutes }: { alert: ServiceAlert; campusRoutes: Set<string> }) {
  const [expanded, setExpanded] = useState(false);
  const description = a.description?.trim();
  const hasDescription = !!description && description !== a.headline;
  const isLong = hasDescription && (description as string).length > LONG_DESCRIPTION;
  const bodyId = `alert-body-${a.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  return (
    <Card as="li" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {a.effect && <Tag tone={EFFECT_TONE[a.effect] ?? 'neutral'}>{humanize(a.effect)}</Tag>}
        <ProviderBadge provider={a.provider} />
        {a.cause && a.cause !== 'UNKNOWN_CAUSE' && <Tag>{humanize(a.cause)}</Tag>}
      </div>
      <h2 className="text-lg font-semibold leading-snug text-ink">{a.headline}</h2>

      {(a.routeCodes ?? []).length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <ul className="flex flex-wrap gap-1.5" aria-label="Routes affected">
            {(a.routeCodes ?? []).map((c) => (
              <li key={c}>
                <Tag tone={campusRoutes.has(c) ? 'sky' : 'neutral'} className="text-base">
                  {c}
                  {campusRoutes.has(c) && <span className="sr-only"> (serves CMU)</span>}
                </Tag>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-base text-ink-soft">System-wide or station notice</p>
      )}

      {hasDescription && (
        <div className="flex flex-col gap-1">
          <p id={bodyId} className={`whitespace-pre-line text-base text-ink-soft ${isLong && !expanded ? 'line-clamp-3' : ''}`}>
            {description}
          </p>
          {isLong && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setExpanded((e) => !e)}
              className="-ml-2 inline-flex min-h-11 items-center self-start rounded-control px-2 font-semibold text-brand hover:bg-surface-2"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <span className="inline-flex items-center gap-2 text-base text-ink-soft">
          <CalendarClock className="size-5 shrink-0" aria-hidden="true" />
          {a.activeStart ? `From ${formatWhen(a.activeStart)}` : 'Active now'}
          {a.activeEnd ? ` until ${formatWhen(a.activeEnd)}` : ''}
        </span>
        {a.url && (
          <a
            href={a.url}
            target="_blank"
            rel="noreferrer"
            className="-mr-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 font-semibold text-brand hover:bg-surface-2"
          >
            Details <ExternalLink className="size-4" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
    </Card>
  );
}

export default function AlertsPage() {
  const { reportError } = useErrorBoundary();
  const [alerts, setAlerts] = useState<ServiceAlert[]>([]);
  const [campusRoutes, setCampusRoutes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campusOnly, setCampusOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [tick, setTick] = useState(0);
  const [lastLoaded, setLastLoaded] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchCampusStops()
      .then((stops) => {
        if (cancelled) return;
        const codes = new Set<string>();
        stops.filter((s) => s.provider === 'PRT').forEach((s) => (s.servedRouteCodes ?? []).forEach((c) => codes.add(c)));
        setCampusRoutes(codes);
      })
      .catch((err) => {
        if (!cancelled) reportError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [reportError]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const force = tick > 0;
    const load = async (forceNow: boolean) => {
      setLoading(true);
      try {
        const rows = await fetchAlerts(forceNow);
        if (cancelled) return;
        setAlerts(rows);
        setError(null);
        setLastLoaded(Date.now());
        setNow(Date.now());
        setLoaded(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(() => load(false), ALERT_POLL_MS);
        }
      }
    };
    load(force);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return alerts
      .filter((a) => !campusOnly || (a.routeCodes ?? []).some((c) => campusRoutes.has(c)))
      .filter(
        (a) =>
          !q ||
          a.headline.toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q) ||
          (a.routeCodes ?? []).some((c) => c.toLowerCase() === q),
      );
  }, [alerts, campusOnly, campusRoutes, query]);

  const updatedText = lastLoaded ? `Updated ${formatAge(Math.round((now - lastLoaded) / 1000))}` : 'Loading…';
  const hasFilters = query.trim().length > 0;

  return (
    <PageContainer>
      <PageHeader
        title="Service alerts"
        description="Detours, closures, and outages published by PRT."
        actions={
          <>
            <span className="text-base text-ink-soft" aria-live="polite">
              {updatedText}
            </span>
            <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading && loaded}>
              Refresh
            </AppButton>
          </>
        }
      />

      <Card as="section" className="flex flex-col gap-3">
        <h2 className="sr-only">Filter alerts</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="alert-search" className="text-base font-semibold text-ink">
            Search alerts
          </label>
          <SearchInput
            id="alert-search"
            placeholder="Route or keyword, like 61C"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery('')}
          />
        </div>
        <div className="-mx-2">
          <ToggleRow
            label="Only routes serving CMU"
            hint={campusOnly ? 'Showing routes that stop on or near campus' : 'Showing every PRT route'}
            checked={campusOnly}
            onChange={setCampusOnly}
          />
        </div>
      </Card>

      {error && (
        <Notice
          tone="error"
          title="Couldn’t load alerts"
          action={
            <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading}>
              Try again
            </AppButton>
          }
        >
          {error}
        </Notice>
      )}

      {loading && !loaded && !error && (
        <>
          <p role="status" className="sr-only">
            Loading alerts
          </p>
          <SkeletonList count={3} />
        </>
      )}

      {loaded && (
        <p className="text-base font-medium text-ink" aria-live="polite">
          {filtered.length === 0
            ? 'No matching alerts'
            : `${filtered.length} active alert${filtered.length === 1 ? '' : 's'}${campusOnly ? ' on CMU routes' : ''}`}
        </p>
      )}

      {loaded && !error && filtered.length === 0 &&
        (hasFilters ? (
          <EmptyState
            icon={<SearchX />}
            tone="lavender"
            title="No alerts match your search"
            action={
              <AppButton onClick={() => setQuery('')} variant="primary">
                Clear search
              </AppButton>
            }
          >
            Try a different route number or word.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<CheckCircle2 />}
            tone="mint"
            title="All clear"
            action={
              campusOnly ? (
                <AppButton onClick={() => setCampusOnly(false)}>Show all PRT routes</AppButton>
              ) : undefined
            }
          >
            {campusOnly ? 'No active PRT alerts affect routes serving CMU.' : 'PRT has no active service alerts right now.'}
          </EmptyState>
        ))}

      {filtered.length > 0 && (
        <ul className="flex flex-col gap-3">
          {filtered.map((a) => (
            <AlertCard key={a.id} alert={a} campusRoutes={campusRoutes} />
          ))}
        </ul>
      )}

      <Notice tone="info" title="Looking for CMU shuttle notices?">
        CMU shuttles don’t publish alerts to this app. Check CMU Parking &amp; Transportation Services for shuttle changes.
      </Notice>
    </PageContainer>
  );
}
