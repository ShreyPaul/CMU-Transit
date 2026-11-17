/*
 * Touch-friendly form controls (44px+ targets, 16px text, visible labels): search field, native select, switch row,
 * and segmented control.
 */
import React, { useRef } from 'react';
import { ChevronDown, Search } from 'lucide-react';

import { cn } from '@/lib/utils';

const FIELD =
  'min-h-12 w-full rounded-control border border-field bg-surface text-base text-ink placeholder:text-ink-soft ' +
  'transition-shadow duration-150 focus:border-focus';

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  onClear?: () => void;
  /** Spinner or other status shown at the right edge, before the Clear button. */
  status?: React.ReactNode;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { onClear, status, className, value, ...rest },
  ref,
) {
  const hasValue = value != null && String(value).length > 0;
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
      <input
        ref={ref}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        value={value}
        className={cn(FIELD, 'pl-11', hasValue && onClear ? 'pr-24' : 'pr-11', className)}
        {...rest}
      />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {status}
        {hasValue && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex min-h-10 items-center rounded-[0.625rem] px-3 text-base font-semibold text-brand hover:bg-surface-2"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
});

export function SelectField({
  id,
  label,
  hint,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={cn(FIELD, 'appearance-none pl-4 pr-11')}
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3.5 top-1/2 size-5 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
      </div>
      {hint && (
        <p id={`${id}-hint`} className="text-base text-ink-soft">
          {hint}
        </p>
      )}
    </div>
  );
}

/** A whole-row switch: the label, hint, and track are one 56px tap target. */
export function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  leading,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  leading?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex min-h-14 w-full items-center gap-3 rounded-control px-2 py-2 text-left hover:bg-surface-2"
    >
      {leading && (
        <span className="flex w-9 shrink-0 justify-center" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-base font-medium text-ink">{label}</span>
        {hint && <span className="text-base text-ink-soft">{hint}</span>}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-150',
          checked ? 'bg-brand' : 'bg-ink-soft',
        )}
      >
        <span
          className={cn(
            'size-5 rounded-full bg-surface shadow-sm transition-transform duration-150',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </span>
    </button>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/** Single-choice segmented control (radio group with arrow-key support). */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('grid auto-cols-fr grid-flow-col gap-1 rounded-control bg-surface-2 p-1', className)}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault();
                move(i, 1);
              } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(i, -1);
              }
            }}
            className={cn(
              'min-h-11 rounded-[0.625rem] px-2 text-base font-medium leading-tight transition-colors duration-150',
              checked ? 'bg-surface text-ink shadow-soft' : 'text-ink-soft hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
