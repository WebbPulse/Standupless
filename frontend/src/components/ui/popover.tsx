/**
 * A floating panel anchored to a trigger, with no library behind it. The panel
 * is positioned with fixed coordinates rather than portalled, so it escapes a
 * scrolling rail or a dialog's overflow while staying inside the dialog's DOM,
 * which keeps that dialog's focus trap and backdrop click working. It flips
 * above the trigger when there is no room below, closes on Escape, on an
 * outside press and on Tab, and hands focus back to the trigger when it closes
 * from the keyboard.
 */

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';

/** What a trigger renderer receives to wire itself to the panel. */
export interface PopoverTriggerProps {
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  'aria-haspopup': 'dialog';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
}

/** Props for Popover: the trigger, the panel content and how it lines up. */
export interface PopoverProps {
  /** Renders the control that opens the panel, given the props it needs. */
  trigger: (props: PopoverTriggerProps) => React.ReactNode;
  /** The panel content, or a renderer handed the close function. */
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  /** The name assistive technology announces for the panel. */
  label: string;
  /** Controlled open state. Leave unset to let the popover hold its own. */
  open?: boolean;
  /** Called whenever the popover asks to open or close. */
  onOpenChange?: (open: boolean) => void;
  /** Which edge of the trigger the panel lines up with. */
  align?: 'start' | 'end';
  /** Stretches the anchor to its container, for a full width trigger. */
  block?: boolean;
  className?: string;
  contentClassName?: string;
}

/** The gap between the trigger and the panel, in pixels. */
const OFFSET = 4;

/** The margin kept between the panel and the viewport edge, in pixels. */
const EDGE = 8;

/** What Tab can land on inside the panel. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where the panel starts before it is measured: hidden, so it never flashes. */
const UNPLACED: React.CSSProperties = { top: 0, left: 0, visibility: 'hidden' };

/** A trigger and the floating panel it opens. */
export const Popover: React.FC<PopoverProps> = ({
  trigger,
  children,
  label,
  open: controlled,
  onOpenChange,
  align = 'start',
  block = false,
  className = '',
  contentClassName = '',
}) => {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const setOpen = useCallback(
    (next: boolean): void => {
      if (controlled === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange]
  );

  const close = useCallback(
    (restoreFocus = true): void => {
      setOpen(false);
      if (restoreFocus) {
        root.current
          ?.querySelector<HTMLElement>(
            'button, [tabindex]:not([tabindex="-1"])'
          )
          ?.focus();
      }
    },
    [setOpen]
  );

  const place = useCallback((): void => {
    const node = panel.current;
    const anchor = root.current?.getBoundingClientRect();
    const box = node?.getBoundingClientRect();
    if (node === null || anchor === undefined || box === undefined) return;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const below = anchor.bottom + OFFSET;
    const fitsBelow = below + box.height <= viewportHeight - EDGE;
    const above = anchor.top - OFFSET - box.height;
    const top = fitsBelow || above < EDGE ? below : above;
    const preferred = align === 'end' ? anchor.right - box.width : anchor.left;
    const left = Math.max(
      EDGE,
      Math.min(preferred, viewportWidth - box.width - EDGE)
    );
    node.style.top = `${String(top)}px`;
    node.style.left = `${String(left)}px`;
    node.style.visibility = 'visible';
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    const onViewport = (): void => {
      place();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [open, close, place]);

  const onPanelKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || panel.current === null) return;
    const items = Array.from(
      panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)
    );
    const edge = event.shiftKey ? items[0] : items[items.length - 1];
    if (items.length === 0 || document.activeElement === edge) {
      event.preventDefault();
      close();
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent): void => {
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div
      ref={root}
      className={cn(block ? 'flex w-full' : 'inline-flex', className)}
    >
      {trigger({
        onClick: () => {
          setOpen(!open);
        },
        onKeyDown: onTriggerKeyDown,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
      })}
      {open && (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          style={UNPLACED}
          className={cn(
            'fixed z-[60] min-w-56 rounded-md border border-line bg-overlay text-sm shadow-overlay',
            contentClassName
          )}
        >
          {typeof children === 'function'
            ? children(() => {
                close();
              })
            : children}
        </div>
      )}
    </div>
  );
};

export default Popover;
