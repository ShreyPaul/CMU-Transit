/*
 * Small presentational pieces shared by the transit pages, built on the app Tag so every status has an icon + word.
 */
import React from 'react';
import { CheckCircle2, CircleAlert, Clock3, KeyRound, Radio } from 'lucide-react';

import { Tag, Tone } from '@/components/app/Surface';
import { DataSourceStatus, TransitProvider } from '@/Interfaces';
import { cn } from '@/lib/utils';
import { PROVIDER_LABEL } from '@/lib/transit';

/** A route code with its operator color swatch. The swatch is an SVG fill because the color comes from feed data. */
export function RouteChip({ code, color, className }: { code?: string; color?: string; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-base font-semibold text-ink', className)}>
      <svg viewBox="0 0 10 10" className="size-3 shrink-0" aria-hidden="true">
        <rect width="10" height="10" rx="2.5" fill={color || 'currentColor'} />
      </svg>
      <span className="truncate">{code ?? '—'}</span>
    </span>
  );
}

export function ProviderBadge({ provider }: { provider: TransitProvider }) {
  return <Tag tone={provider === 'PRT' ? 'sky' : 'lavender'}>{PROVIDER_LABEL[provider]}</Tag>;
}

const STATUS: Record<DataSourceStatus, { tone: Tone; label: string; Icon: typeof Clock3 }> = {
  OK: { tone: 'mint', label: 'Working', Icon: CheckCircle2 },
  ERROR: { tone: 'rose', label: 'Failing', Icon: CircleAlert },
  NOT_CONFIGURED: { tone: 'peach', label: 'Needs key', Icon: KeyRound },
  NOT_CHECKED: { tone: 'neutral', label: 'Not checked', Icon: Clock3 },
};

export function StatusBadge({ status }: { status: DataSourceStatus }) {
  const { tone, label, Icon } = STATUS[status];
  return (
    <Tag tone={tone} icon={<Icon aria-hidden="true" />}>
      {label}
    </Tag>
  );
}

/** Live or schedule-based prediction marker, so estimates are never shown as verified tracking. */
export function PredictionBadge({ realtime }: { realtime?: boolean }) {
  return realtime ? (
    <Tag tone="mint" icon={<Radio aria-hidden="true" />}>
      Live
    </Tag>
  ) : (
    <Tag tone="neutral" icon={<Clock3 aria-hidden="true" />}>
      Scheduled
    </Tag>
  );
}
