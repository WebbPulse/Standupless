/**
 * A hover and keyboard focus tooltip with no library behind it. The bubble is
 * hidden from assistive technology because the control it sits on already
 * carries the same text as its label; the tooltip exists for sighted people
 * hovering an icon.
 *
 * It opens after a short hover delay, or at once when focus arrives from the
 * keyboard, and closes on leave, blur, Escape, a press or unmount. A press
 * keeps it shut until the pointer leaves, so clicking a control never leaves
 * its bubble hanging over what the click opened.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

/** How long a hover rests before the bubble opens, in ms. */
export const TOOLTIP_DELAY_MS = 300;

/** Props for Tooltip: the text and the one control it belongs to. */
export interface TooltipProps {
  text: string;
  children: React.ReactNode;
  /** Where the bubble opens. */
  side?: 'top' | 'bottom';
  className?: string;
}

/** Whether focus on an element came from the keyboard rather than a click. */
const focusIsVisible = (element: Element): boolean => {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
};

/** Wraps one control and shows its text beneath it on hover or keyboard focus. */
export const Tooltip: React.FC<TooltipProps> = ({
  text,
  children,
  side = 'bottom',
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);

  const clear = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const hide = useCallback((): void => {
    clear();
    setOpen(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return (
    <span
      className={cn('relative inline-flex', className)}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || pressed.current) return;
        clear();
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setOpen(true);
        }, TOOLTIP_DELAY_MS);
      }}
      onPointerLeave={() => {
        pressed.current = false;
        hide();
      }}
      onPointerDown={() => {
        pressed.current = true;
        hide();
      }}
      onClick={hide}
      onFocus={(event) => {
        if (!pressed.current && focusIsVisible(event.target)) setOpen(true);
      }}
      onBlur={hide}
      onKeyDown={(event) => {
        if (
          event.key === 'Escape' ||
          event.key === 'Enter' ||
          event.key === ' '
        )
          hide();
      }}
    >
      {children}
      <span
        role="tooltip"
        aria-hidden="true"
        data-open={open ? '' : undefined}
        className={cn(
          'pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-sm bg-text px-2 py-1 text-2xs font-medium whitespace-nowrap text-bg shadow-overlay transition-opacity duration-100',
          open ? 'opacity-100' : 'opacity-0',
          side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
        )}
      >
        {text}
      </span>
    </span>
  );
};

export default Tooltip;
