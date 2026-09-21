/**
 * The small inline markers: a tinted badge for counts and states, a label chip
 * carrying its team colour, and a keyboard key.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** The tints a badge can take. */
export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

/** Props for Badge: the tint and the content. */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-raised text-text-muted',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  warning: 'bg-warning-soft text-warning',
  success: 'bg-success-soft text-success',
};

/** A small tinted pill. */
export const Badge: React.FC<BadgeProps> = ({
  tone = 'neutral',
  className = '',
  ...props
}) => (
  <span
    className={cn(
      'inline-flex h-5 items-center rounded-full px-1.5 text-2xs font-medium whitespace-nowrap',
      TONES[tone],
      className
    )}
    {...props}
  />
);

/** Props for LabelChip: the label's colour and name. */
export interface LabelChipProps {
  color: string;
  name: string;
  className?: string;
}

/** A team label as a dot and its name. */
export const LabelChip: React.FC<LabelChipProps> = ({
  color,
  name,
  className = '',
}) => (
  <span
    className={cn(
      'inline-flex h-5 items-center gap-1.5 rounded-full border border-line px-1.5 text-2xs text-text-muted whitespace-nowrap',
      className
    )}
  >
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
    {name}
  </span>
);

/** A keyboard key, for shortcut hints. */
export const Kbd: React.FC<React.HTMLAttributes<HTMLElement>> = ({
  className = '',
  ...props
}) => (
  <kbd
    className={cn(
      'inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-line-strong bg-raised px-1 font-sans text-2xs text-text-muted',
      className
    )}
    {...props}
  />
);

export default Badge;
