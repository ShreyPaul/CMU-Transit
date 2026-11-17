/*
 * Layout and status building blocks shared by every screen: page container and header, cards, tags, notices,
 * empty and loading states, and expandable sections.
 */
import React, { useId, useState } from 'react';
import { CheckCircle2, ChevronDown, CircleAlert, Info, Loader2, TriangleAlert, X } from 'lucide-react';

import { cn } from '@/lib/utils';

export type Tone = 'sky' | 'lavender' | 'mint' | 'peach' | 'rose' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  sky: 'bg-tint-sky text-tint-sky-ink',
  lavender: 'bg-tint-lavender text-tint-lavender-ink',
  mint: 'bg-tint-mint text-tint-mint-ink',
  peach: 'bg-tint-peach text-tint-peach-ink',
  rose: 'bg-tint-rose text-tint-rose-ink',
  neutral: 'bg-surface-2 text-ink-soft',
};

/** Centered, padded content column for list pages. */
export function PageContainer({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8', className)}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="text-[1.75rem] font-bold leading-tight tracking-tight text-ink sm:text-[2rem]">{title}</h1>
        {description && <p className="max-w-prose text-base text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Card({
  children,
  className,
  as: Element = 'div',
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Element className={cn('rounded-card border border-line bg-surface p-4 shadow-soft sm:p-5', className)}>{children}</Element>
  );
}

export function SectionTitle({ children, id, action }: { children: React.ReactNode; id?: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2">
      <h2 id={id} className="text-lg font-semibold text-ink">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Small rounded label. Pair color with an icon or word so meaning never depends on color alone. */
export function Tag({
  tone = 'neutral',
  icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-medium leading-5 [&_svg]:size-3.5 [&_svg]:shrink-0',
        TONE_CLASS[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const NOTICE: Record<NoticeTone, { tone: Tone; Icon: typeof Info }> = {
  info: { tone: 'sky', Icon: Info },
  success: { tone: 'mint', Icon: CheckCircle2 },
  warning: { tone: 'peach', Icon: TriangleAlert },
  error: { tone: 'rose', Icon: CircleAlert },
};

/** Inline message: errors are announced immediately (role=alert), everything else politely (role=status). */
export function Notice({
  tone,
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone: NoticeTone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const { tone: t, Icon } = NOTICE[tone];
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-card p-4', TONE_CLASS[t], className)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-semibold">{title}</p>
        {children && <div className="text-base [overflow-wrap:anywhere]">{children}</div>}
        {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="-m-1 inline-flex min-h-11 shrink-0 items-center gap-1 self-start rounded-control px-2 font-medium hover:bg-black/5 dark:hover:bg-white/10"
        >
          <X className="size-4" aria-hidden="true" />
          Dismiss
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon,
  tone = 'sky',
  title,
  children,
  action,
  compact,
}: {
  icon: React.ReactNode;
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-card border border-dashed border-line-strong bg-surface text-center',
        compact ? 'px-4 py-6' : 'px-6 py-10',
      )}
    >
      <span className={cn('flex size-14 items-center justify-center rounded-full [&_svg]:size-7', TONE_CLASS[tone])} aria-hidden="true">
        {icon}
      </span>
      <h3 className="text-lg font-semibold text-ink">{title}</h3>
      {children && <div className="max-w-sm text-base text-ink-soft">{children}</div>}
      {action && <div className="mt-1 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center gap-3 text-base text-ink-soft', className)}>
      <Loader2 className="size-5 shrink-0 text-brand motion-safe:animate-spin" aria-hidden="true" />
      {label}
    </div>
  );
}

/** Placeholder cards shown while a list loads. */
export function SkeletonList({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-3', className)} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
          <div className="h-5 w-1/3 rounded-full bg-surface-2 motion-safe:animate-pulse" />
          <div className="h-4 w-4/5 rounded-full bg-surface-2 motion-safe:animate-pulse" />
          <div className="h-4 w-3/5 rounded-full bg-surface-2 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** Expandable section for secondary details. */
export function Disclosure({
  title,
  icon,
  defaultOpen = false,
  children,
  className,
  bare,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  /** No border or background, for use inside an existing card. */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cn(!bare && 'rounded-control border border-line bg-surface', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex min-h-12 w-full items-center gap-3 rounded-control text-left text-base font-semibold text-ink hover:bg-surface-2 [&_svg]:size-5 [&_svg]:shrink-0',
          bare ? '-mx-2 w-[calc(100%+1rem)] px-2' : 'px-4',
        )}
      >
        {icon && <span className="text-ink-soft">{icon}</span>}
        <span className="min-w-0 flex-1">{title}</span>
        <ChevronDown className={cn('text-ink-soft transition-transform duration-150', open && 'rotate-180')} aria-hidden="true" />
      </button>
      <div id={id} hidden={!open} className={cn(bare ? 'pb-1 pt-2' : 'px-4 pb-4 pt-1')}>
        {open && children}
      </div>
    </div>
  );
}

/** Label/value pair for detail grids. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-base text-ink-soft">{label}</dt>
      <dd className="text-base font-medium text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
