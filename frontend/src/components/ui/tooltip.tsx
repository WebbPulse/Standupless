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
 *
 * The bubble renders in a portal on the document body with fixed positioning,
 * so a panel with its own overflow, such as the issue properties rail, never
 * clips it or grows a scrollbar while it is open. A closed bubble takes no
 * layout, and an open one flips to the other side when its own side has no
 * room and is nudged back inside the viewport, so a tooltip on a control at
 * the window's edge never widens the page into a horizontal scroll. Scrolling
 * or resizing closes it, because a fixed bubble would otherwise drift away
 * from its control.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { placeBeside, shiftIntoView } from '../../lib/viewport';

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

/** A store subscription that never fires, so only server and client differ. */
const subscribeNothing = (): (() => void) => () => undefined;

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
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);
  const bubble = useRef<HTMLSpanElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const clear = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const hide = useCallback((): void => {
    clear();
    setOpen(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  useLayoutEffect(() => {
    const node = bubble.current;
    const trigger = anchor.current;
    if (node === null || trigger === null || !open) return;
    const target = trigger.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    const top = placeBeside(
      target.top,
      target.bottom,
      own.height,
      height,
      side
    );
    const left = target.left + target.width / 2 - own.width / 2;
    const shift = shiftIntoView(left, left + own.width, width);
    node.style.top = `${String(top)}px`;
    node.style.left = `${String(left + shift)}px`;
  }, [open, text, side]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  return (
    <span
      ref={anchor}
      className={cn('inline-flex', className)}
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
      {mounted &&
        createPortal(
          <span
            ref={bubble}
            role="tooltip"
            aria-hidden="true"
            data-open={open ? '' : undefined}
            className="pointer-events-none fixed top-0 left-0 z-70 rounded-sm bg-text px-2 py-1 text-2xs font-medium whitespace-pre text-bg shadow-overlay transition-opacity duration-100 not-data-open:hidden starting:opacity-0"
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
};

export default Tooltip;
