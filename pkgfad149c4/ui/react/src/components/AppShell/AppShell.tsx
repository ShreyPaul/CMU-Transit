/*
 * App chrome: a slim top bar (brand, desktop links, theme switch) and a bottom tab bar for phones and tablets.
 * Both are driven by `navigationConfig`, so adding a route there adds it to both.
 */
import React from 'react';
import { NavLink } from 'react-router-dom';
import { BusFront, Moon, Sun } from 'lucide-react';

import { navigationConfig } from '@/config/navigation';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

export function SkipLink() {
  return (
    <a
      href="#main-content"
      onClick={(e) => {
        // Hash routing owns location.hash, so move focus without navigating.
        e.preventDefault();
        document.getElementById('main-content')?.focus();
      }}
      className="sr-only z-[2000] rounded-control bg-brand px-4 py-3 font-semibold text-on-brand focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
    >
      Skip to content
    </a>
  );
}

export function AppHeader() {
  const { currentTheme, toggleTheme } = useTheme();
  const dark = currentTheme === 'dark';
  const ThemeIcon = dark ? Sun : Moon;

  return (
    <header className="relative z-[1200] flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 sm:px-5">
      <NavLink to="/" className="flex min-h-11 min-w-0 items-center gap-2.5 rounded-control pr-2">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[0.75rem] bg-tint-sky text-tint-sky-ink" aria-hidden="true">
          <BusFront className="size-6" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-lg font-bold text-ink">CMU Transit</span>
          <span className="hidden truncate text-sm text-ink-soft sm:block">Live buses &amp; shuttles</span>
        </span>
      </NavLink>

      <nav aria-label="Main" className="ml-4 hidden flex-1 items-center gap-1 md:flex">
        {navigationConfig.map((item) => (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === '/'}
            title={item.tooltip}
            className={({ isActive }) =>
              cn(
                'inline-flex min-h-11 items-center gap-2 rounded-control px-4 text-base font-semibold transition-colors duration-150',
                isActive ? 'bg-tint-sky text-tint-sky-ink' : 'text-ink-soft hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            <item.icon className="size-5" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        onClick={toggleTheme}
        className="ml-auto inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control px-3 text-base font-medium text-ink hover:bg-surface-2"
      >
        <ThemeIcon className="size-5" aria-hidden="true" />
        <span>
          {dark ? 'Light' : 'Dark'}
          <span className="sr-only"> mode</span>
        </span>
      </button>
    </header>
  );
}

export function BottomNav() {
  return (
    <nav
      aria-label="Main"
      className="relative z-[1200] shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-3">
        {navigationConfig.map((item) => (
          <li key={item.id}>
            <NavLink
              to={item.path}
              end={item.path === '/'}
              className={({ isActive }) =>
                cn(
                  'group flex min-h-16 flex-col items-center justify-center gap-1 px-2 text-sm font-semibold transition-colors duration-150',
                  isActive ? 'text-tint-sky-ink' : 'text-ink-soft hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    className={cn(
                      'flex h-8 w-14 items-center justify-center rounded-full transition-colors duration-150',
                      isActive ? 'bg-tint-sky' : 'group-hover:bg-surface-2',
                    )}
                    aria-hidden="true"
                  >
                    <item.icon className="size-5" />
                  </span>
                  {item.label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
