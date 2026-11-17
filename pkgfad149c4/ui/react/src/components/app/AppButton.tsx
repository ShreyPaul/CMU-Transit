/*
 * The one button used across the app. Every size is at least 44px tall, and buttons always carry a text label next to
 * their icon (pass `srLabel` only to add context for screen readers, never to replace the visible text).
 */
import React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

export type AppButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
export type AppButtonSize = 'md' | 'lg';

const VARIANT: Record<AppButtonVariant, string> = {
  primary: 'bg-brand text-on-brand shadow-soft hover:bg-brand-strong',
  secondary: 'border border-line-strong bg-surface text-ink hover:bg-surface-2',
  soft: 'bg-tint-sky text-tint-sky-ink hover:brightness-95',
  ghost: 'bg-transparent text-ink hover:bg-surface-2',
  danger: 'bg-tint-rose text-tint-rose-ink hover:brightness-95',
};

const SIZE: Record<AppButtonSize, string> = {
  md: 'min-h-11 px-4 py-2',
  lg: 'min-h-12 px-5 py-2.5',
};

export interface AppButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: AppButtonVariant;
  size?: AppButtonSize;
  /** Icon shown before the label. Replaced by a spinner while `loading`. */
  icon?: React.ReactNode;
  trailingIcon?: React.ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
}

export const AppButton = React.forwardRef<HTMLButtonElement, AppButtonProps>(function AppButton(
  { variant = 'secondary', size = 'md', icon, trailingIcon, loading, fullWidth, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type === 'submit' ? 'submit' : 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center gap-2 rounded-control text-base font-semibold leading-tight',
        'transition-[background-color,filter,color] duration-150 disabled:cursor-not-allowed disabled:opacity-55',
        '[&_svg]:size-5 [&_svg]:shrink-0',
        VARIANT[variant],
        SIZE[size],
        fullWidth && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : icon}
      {children != null && <span className="min-w-0 text-center">{children}</span>}
      {trailingIcon}
    </button>
  );
});
