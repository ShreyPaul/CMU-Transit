/*
 * Address / place / stop autocomplete backed by TransitGeocoder.search. Suggestions appear as the user types
 * (debounced, 3+ characters); arrow keys move through them, Enter or tap picks one.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Bus, Loader2, LocateFixed, MapPin, School } from 'lucide-react';

import { SearchInput } from '@/components/app/Controls';
import { searchPlaces } from '@/api/transit';
import { GeoPlace } from '@/Interfaces';
import { cn } from '@/lib/utils';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

/** A fixed choice listed above the suggestions, such as "My location". */
export interface QuickChoice {
  id: string;
  label: string;
  detail?: string;
  icon: 'me' | 'campus';
  onChoose: () => void;
}

interface PlaceAutocompleteProps {
  /** Visible field label. Omit only when a visible label is rendered elsewhere and passed via `labelledBy`. */
  label?: string;
  labelledBy?: string;
  placeholder: string;
  onSelect: (place: GeoPlace) => void;
  /** Bias suggestions toward this point. */
  near?: [number, number];
  quickChoices?: QuickChoice[];
  autoFocus?: boolean;
  /** Clear the text after a choice (main search) instead of keeping it (origin field). */
  clearOnSelect?: boolean;
}

type Item = { type: 'quick'; quick: QuickChoice } | { type: 'place'; place: GeoPlace };

export default function PlaceAutocomplete({
  label,
  labelledBy,
  placeholder,
  onSelect,
  near,
  quickChoices = [],
  autoFocus,
  clearOnSelect,
}: PlaceAutocompleteProps) {
  const baseId = useId();
  const inputId = `${baseId}-input`;
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const labelId = `${baseId}-label`;
  const [text, setText] = useState('');
  const [results, setResults] = useState<GeoPlace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [tooShort, setTooShort] = useState(false);
  const requestSeq = useRef(0);

  const nearKey = near ? `${near[0].toFixed(3)},${near[1].toFixed(3)}` : '';

  useEffect(() => {
    const q = text.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    setTooShort(false);
    const seq = ++requestSeq.current;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const rows = await searchPlaces(q, near);
        // Ignore responses for text the user has since changed.
        if (seq !== requestSeq.current) return;
        setResults(rows);
        setError(null);
        setActive(rows.length ? 0 : -1);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setResults([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // `near` is compared by its rounded key so a moving map does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, nearKey]);

  const trimmed = text.trim();
  const showQuick = trimmed.length < MIN_CHARS;
  const items: Item[] = showQuick
    ? quickChoices.map((quick) => ({ type: 'quick', quick }))
    : results.map((place) => ({ type: 'place', place }));

  const choose = (item: Item) => {
    if (item.type === 'quick') {
      item.quick.onChoose();
      setText('');
    } else {
      onSelect(item.place);
      setText(clearOnSelect ? '' : item.place.label);
    }
    requestSeq.current++;
    setResults([]);
    setOpen(false);
    setActive(-1);
    setTooShort(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[active >= 0 ? active : 0];
      if (item) choose(item);
      else if (trimmed.length > 0 && trimmed.length < MIN_CHARS) setTooShort(true);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const expanded = open && (items.length > 0 || loading || !!error || (!showQuick && !loading));
  const activeId = active >= 0 && items[active] ? `${listId}-opt-${active}` : undefined;

  // Inline guidance under the field: validation first, then a short hint while typing.
  const hint =
    tooShort || (trimmed.length > 0 && trimmed.length < MIN_CHARS)
      ? `Type at least ${MIN_CHARS} letters to see suggestions.`
      : null;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label id={labelId} htmlFor={inputId} className="text-base font-semibold text-ink">
          {label}
        </label>
      )}
      <div className="relative">
        <SearchInput
          id={inputId}
          placeholder={placeholder}
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          onClear={() => {
            setText('');
            setResults([]);
            setTooShort(false);
          }}
          status={loading ? <Loader2 className="mx-2 size-5 text-brand motion-safe:animate-spin" aria-label="Searching" /> : null}
          role="combobox"
          aria-labelledby={label ? labelId : labelledBy}
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          aria-describedby={hint ? hintId : undefined}
          aria-invalid={tooShort || undefined}
          autoComplete="off"
        />
        {expanded && (
          <div className="app-rise absolute left-0 right-0 top-full z-[1300] mt-2 overflow-hidden rounded-card border border-line bg-surface shadow-float">
            {loading && !results.length && (
              <p role="status" className="flex min-h-12 items-center gap-2 px-4 text-base text-ink-soft">
                Searching…
              </p>
            )}
            {error && (
              <p role="alert" className="px-4 py-3 text-base text-tint-rose-ink">
                Search is unavailable right now. {error}
              </p>
            )}
            {!loading && !error && !showQuick && results.length === 0 && (
              <p role="status" className="px-4 py-3 text-base text-ink-soft">
                No matches in the Pittsburgh area. Try a street, building, or stop name.
              </p>
            )}
            {items.length > 0 && (
              <ul id={listId} role="listbox" aria-label="Suggestions" className="max-h-80 overflow-auto py-1">
                {items.map((item, i) => {
                  const key =
                    item.type === 'quick' ? item.quick.id : `${item.place.kind}-${item.place.stopId ?? ''}-${item.place.label}-${i}`;
                  const itemLabel = item.type === 'quick' ? item.quick.label : item.place.label;
                  const detail = item.type === 'quick' ? item.quick.detail : item.place.detail;
                  const Icon =
                    item.type === 'quick'
                      ? item.quick.icon === 'me'
                        ? LocateFixed
                        : School
                      : item.place.kind === 'STOP'
                        ? Bus
                        : MapPin;
                  const kindLabel = item.type === 'place' ? (item.place.kind === 'STOP' ? 'Stop' : 'Place') : null;
                  return (
                    <li
                      key={key}
                      id={`${listId}-opt-${i}`}
                      role="option"
                      aria-selected={i === active}
                      tabIndex={-1}
                      // mousedown fires before the input's blur, so the choice is not lost when the list closes.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(item);
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={cn(
                        'flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2',
                        i === active ? 'bg-tint-sky' : 'hover:bg-surface-2',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-9 shrink-0 items-center justify-center rounded-full',
                          kindLabel === 'Stop' ? 'bg-tint-lavender text-tint-lavender-ink' : 'bg-surface-2 text-ink-soft',
                        )}
                        aria-hidden="true"
                      >
                        <Icon className="size-5" />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-base font-medium text-ink">
                          {itemLabel}
                          {kindLabel && <span className="sr-only">, {kindLabel}</span>}
                        </span>
                        {detail && <span className="truncate text-base text-ink-soft">{detail}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      {hint && (
        <p id={hintId} className={cn('text-base', tooShort ? 'font-medium text-tint-peach-ink' : 'text-ink-soft')}>
          {hint}
        </p>
      )}
    </div>
  );
}
