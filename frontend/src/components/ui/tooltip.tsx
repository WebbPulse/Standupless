/**
 * A hover and focus tooltip with no library behind it. The bubble is hidden
 * from assistive technology because the control it sits on already carries the
 * same text as its label; the tooltip exists for sighted people hovering an
 * icon.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Tooltip: the text and the one control it belongs to. */
export interface TooltipProps {
  text: string;
  children: React.ReactNode;
  /** Where the bubble opens. */
  side?: 'top' | 'bottom';
  className?: string;
}

/** Wraps one control and shows its text beneath it on hover or focus. */
export const Tooltip: React.FC<TooltipProps> = ({
  text,
  children,
  side = 'bottom',
  className = '',
}) => (
  <span className={cn('group/tip relative inline-flex', className)}>
    {children}
    <span
      role="tooltip"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-sm bg-text px-2 py-1 text-2xs font-medium whitespace-nowrap text-bg opacity-0 shadow-overlay transition-opacity delay-300 duration-100 group-focus-within/tip:opacity-100 group-hover/tip:opacity-100',
        side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
      )}
    >
      {text}
    </span>
  </span>
);

export default Tooltip;
