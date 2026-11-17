/*
 * Map overlays. On phones and tablets a sheet docks to the bottom of the map; from the `lg` breakpoint it floats as a
 * side panel. Escape closes it and focus moves into it when it opens, so keyboard and screen-reader users land on
 * the new content.
 */
import React, { useEffect, useRef } from 'react';
import { ArrowLeft, X } from 'lucide-react';

import { AppButton } from '@/components/app/AppButton';
import { cn } from '@/lib/utils';

export function MapSheet({
  label,
  onClose,
  children,
  placement = 'right',
  className,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  placement?: 'left' | 'right';
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, []);

  return (
    <aside
      ref={ref}
      tabIndex={-1}
      aria-label={label}
      className={cn(
        'app-rise absolute z-[1100] flex flex-col bg-surface text-ink shadow-float focus-visible:outline-none',
        // Phones: full-width bottom sheet.
        'inset-x-0 bottom-0 max-h-[72%] rounded-t-sheet border-t border-line',
        // Tablets: centered floating sheet.
        'sm:inset-x-0 sm:bottom-3 sm:mx-auto sm:w-[calc(100%-1.5rem)] sm:max-w-xl sm:rounded-sheet sm:border',
        // Desktop: side panel.
        'lg:bottom-auto lg:top-4 lg:mx-0 lg:max-h-[calc(100%-2rem)] lg:w-[25rem] lg:max-w-none lg:rounded-card',
        placement === 'right' ? 'lg:left-auto lg:right-4' : 'lg:left-4 lg:right-auto',
        className,
      )}
    >
      <div className="flex shrink-0 justify-center pt-2 lg:hidden" aria-hidden="true">
        <span className="h-1.5 w-10 rounded-full bg-line-strong" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-3 sm:px-5 lg:pt-5">{children}</div>
    </aside>
  );
}

/**
 * Title block at the top of every map panel, with an optional labelled Close button. A `closeLabel` of "Back" shows a
 * back arrow, for panels opened from another panel (for example a bus opened from directions).
 */
export function PanelHeader({
  eyebrow,
  title,
  subtitle,
  onClose,
  closeLabel = 'Close',
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {eyebrow && <div className="flex flex-wrap items-center gap-2">{eyebrow}</div>}
        <h2 className="text-xl font-bold leading-snug text-ink [overflow-wrap:anywhere]">{title}</h2>
        {subtitle && <p className="line-clamp-2 text-base text-ink-soft">{subtitle}</p>}
      </div>
      {onClose && (
        <AppButton variant="ghost" icon={closeLabel === 'Back' ? <ArrowLeft /> : <X />} onClick={onClose} className="-mr-2 -mt-1 px-3">
          {closeLabel}
        </AppButton>
      )}
    </div>
  );
}
