/*
 * Data sources page: every external API with access requirements, rate limits, and the result of its last call.
 * Shown as filterable cards (status first, technical details on request) instead of a wide table.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Gauge, KeyRound, RefreshCw, SearchX, ShieldCheck } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { Card, Disclosure, EmptyState, Fact, Notice, PageContainer, PageHeader, SkeletonList, Tag, Tone } from '@/components/app/Surface';
import { StatusBadge } from '@/components/transit/TransitBits';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { checkAllDataSources, fetchDataSources } from '@/api/transit';
import { DataSourceCategory, DataSourceStatus, TransitDataSource } from '@/Interfaces';
import { formatAge } from '@/lib/transit';
import { cn } from '@/lib/utils';

const CATEGORY_LABEL: Record<DataSourceCategory, string> = {
  TRANSIT_REALTIME: 'Live transit',
  TRANSIT_STATIC: 'Transit network',
  WEATHER: 'Weather',
  ELEVATION: 'Elevation',
  ROUTING: 'Walking routes',
  GEOCODING: 'Place search',
  NEWS: 'News',
  TRAFFIC: 'Traffic',
  MAPS: 'Maps',
};

type Filter = 'ALL' | DataSourceStatus;

const FILTERS: { value: Filter; label: string; tone: Tone }[] = [
  { value: 'ALL', label: 'All', tone: 'neutral' },
  { value: 'OK', label: 'Working', tone: 'mint' },
  { value: 'NOT_CONFIGURED', label: 'Needs key', tone: 'peach' },
  { value: 'ERROR', label: 'Failing', tone: 'rose' },
];

function age(iso?: string, now = Date.now()): string {
  return iso ? formatAge(Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))) : 'never';
}

function summarize(sources: TransitDataSource[]): Record<Filter, number> {
  const counts: Record<Filter, number> = { ALL: sources.length, OK: 0, ERROR: 0, NOT_CONFIGURED: 0, NOT_CHECKED: 0 };
  sources.forEach((s) => (counts[s.status] += 1));
  return counts;
}

function SourceCard({ source: s }: { source: TransitDataSource }) {
  return (
    <Card as="li" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-lg font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{s.displayName}</h2>
          <p className="text-base text-ink-soft">{s.vendor}</p>
        </div>
        <StatusBadge status={s.status} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Tag tone="lavender">{CATEGORY_LABEL[s.category]}</Tag>
        {s.credentialField ? (
          <Tag tone="neutral" icon={<KeyRound aria-hidden="true" />}>
            API key
          </Tag>
        ) : (
          <Tag tone="neutral">No key needed</Tag>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Fact label="Last success">{age(s.lastSuccessAt)}</Fact>
        <Fact label="Response time">{s.lastLatencyMs != null ? `${s.lastLatencyMs} ms` : '—'}</Fact>
      </dl>

      {s.status === 'ERROR' && s.lastError && (
        <Notice tone="error" title="Last call failed">
          {s.lastError}
        </Notice>
      )}

      <Disclosure title="Details" bare className="border-t border-line pt-1">
        <dl className="flex flex-col gap-3">
          <Fact label="Access">
            {s.credentialField ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                Secret <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.9375rem]">{s.credentialField}</code>
              </span>
            ) : (
              'Keyless'
            )}
          </Fact>
          {s.phase != null && <Fact label="Phase">{s.phase}</Fact>}
          {s.rateLimitNote && <Fact label="Usage policy">{s.rateLimitNote}</Fact>}
          {s.notes && <Fact label="Notes">{s.notes}</Fact>}
          {s.lastRecordCount != null && <Fact label="Records in last call">{s.lastRecordCount}</Fact>}
        </dl>
        {s.docsUrl && (
          <a
            href={s.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="-ml-2 mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-control px-2 font-semibold text-brand hover:bg-surface-2"
          >
            Documentation <ExternalLink className="size-4" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </Disclosure>
    </Card>
  );
}

export default function DataSourcesPage() {
  const { reportError } = useErrorBoundary();
  const [sources, setSources] = useState<TransitDataSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<Record<Filter, number> | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchDataSources()
      .then((rows) => {
        if (!cancelled) {
          setSources(rows);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const runCheck = async () => {
    setChecking(true);
    setCheckResult(null);
    try {
      await checkAllDataSources();
      const rows = await fetchDataSources();
      setSources(rows);
      setCheckResult(summarize(rows));
      setError(null);
    } catch (err) {
      reportError(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const counts = useMemo(() => summarize(sources), [sources]);
  const visible = useMemo(() => (filter === 'ALL' ? sources : sources.filter((s) => s.status === filter)), [sources, filter]);

  return (
    <PageContainer>
      <PageHeader
        title="Data sources"
        description="The live feeds and services this app uses, and whether each one is working."
        actions={
          <AppButton variant="primary" icon={<ShieldCheck />} onClick={runCheck} loading={checking} disabled={loading} className="whitespace-nowrap">
            {checking ? 'Checking…' : 'Run health check'}
          </AppButton>
        }
      />

      {checkResult && (
        <Notice tone={checkResult.ERROR > 0 ? 'warning' : 'success'} title="Health check finished" onDismiss={() => setCheckResult(null)}>
          {checkResult.OK} working, {checkResult.ERROR} failing, {checkResult.NOT_CONFIGURED} need an API key.
        </Notice>
      )}

      {error && (
        <Notice
          tone="error"
          title="Couldn’t load data sources"
          action={
            <AppButton icon={<RefreshCw />} onClick={() => setTick((t) => t + 1)} loading={loading}>
              Try again
            </AppButton>
          }
        >
          {error}
        </Notice>
      )}

      {!loading && sources.length > 0 && (
        <div role="group" aria-label="Filter by status" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {FILTERS.map((f) => {
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'flex min-h-16 flex-col items-start justify-center rounded-card border-2 px-4 py-2 text-left transition-colors duration-150',
                  active ? 'border-brand bg-surface shadow-soft' : 'border-transparent bg-surface hover:border-line-strong',
                )}
              >
                <span className="text-2xl font-bold leading-tight text-ink">{counts[f.value]}</span>
                <span className="inline-flex items-center gap-1.5 text-base font-medium text-ink-soft">
                  {f.value !== 'ALL' && <span className={cn('size-2.5 rounded-full', f.tone === 'mint' ? 'bg-tint-mint-ink' : f.tone === 'peach' ? 'bg-tint-peach-ink' : 'bg-tint-rose-ink')} aria-hidden="true" />}
                  {f.label}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {counts.NOT_CONFIGURED > 0 && (
        <Disclosure icon={<KeyRound />} title="How to turn on sources that need a key">
          <p className="text-base text-ink-soft">
            Sources marked “Needs key” are never called, and their data is not shown. An administrator adds the key to the
            TransitConfig secret listed under that source’s Details (C3 console:{' '}
            <code className="font-mono text-[0.9375rem]">TransitConfig.inst().setSecretValue(&apos;&lt;field&gt;&apos;, …)</code>).
            Never paste keys into chat.
          </p>
        </Disclosure>
      )}

      {loading && (
        <>
          <p role="status" className="sr-only">
            Loading data sources
          </p>
          <SkeletonList count={4} className="md:grid md:grid-cols-2" />
        </>
      )}

      {!loading && !error && sources.length === 0 && (
        <EmptyState icon={<Gauge />} title="No data sources yet" tone="lavender">
          Data sources appear here once the app’s reference data has been loaded.
        </EmptyState>
      )}

      {!loading && sources.length > 0 && visible.length === 0 && (
        <EmptyState
          icon={<SearchX />}
          tone="mint"
          title={`No sources are “${FILTERS.find((f) => f.value === filter)?.label}”`}
          action={<AppButton onClick={() => setFilter('ALL')}>Show all sources</AppButton>}
        >
          {filter === 'ERROR' ? 'Everything that was checked is responding.' : 'Try another filter.'}
        </EmptyState>
      )}

      {!loading && visible.length > 0 && (
        <ul className="grid grid-cols-1 items-start gap-3 md:grid-cols-2" aria-label="Data sources">
          {visible.map((s) => (
            <SourceCard key={s.id} source={s} />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
