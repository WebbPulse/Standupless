/**
 * A preview card that opens when the pointer rests on a trigger, with no
 * library behind it. It opens after {@link HOVER_CARD_OPEN_DELAY_MS}, or almost
 * at once while another card is open or has just closed, so sweeping across a
 * run of references reads each one without waiting again. Leaving the trigger
 * closes it after a short grace that lets the pointer cross into the card,
 * which keeps it open. Keyboard focus that came from the keyboard opens it too;
 * Escape, a press, blur, typing, scrolling and resizing close it. Touch never
 * opens one, since a tap already follows the link.
 *
 * The card renders in a portal on the document body with fixed positioning,
 * below its trigger or above it when there is no room, and inside the viewport.
 * Only one card is open at a time across the page.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/cn';
import { placeBeside, shiftIntoView } from '../../lib/viewport';
import { UNPLACED } from './anchoredPlacement';
import { focusIsVisible } from './tooltip';

/** How long the pointer rests on a trigger before its card opens, in ms. */
export const HOVER_CARD_OPEN_DELAY_MS = 400;

/** How soon a card opens while another is open or has just closed, in ms. */
export const HOVER_CARD_WARM_DELAY_MS = 60;

/** How long a card waits after the pointer leaves before it closes, in ms. */
export const HOVER_CARD_CLOSE_DELAY_MS = 150;

/** How long after a card closes the next one still opens warm, in ms. */
const WARM_WINDOW_MS = 400;

/** The card open on the page, if any: its owner and how to close it. */
let active: { owner: object; close: () => void } | null = null;

/** When the last card closed, in epoch milliseconds. */
let lastClosedAt = 0;

/** Whether the device can hover, so a card has any way to be read. */
export const canHover = (): boolean =>
  typeof window.matchMedia !== 'function' ||
  !window.matchMedia('(hover: none)').matches;

/** The handle a trigger and its card share. */
export interface HoverCardController {
  /** The element the open card hangs off, or null while closed. */
  anchor: HTMLElement | null;
  /** Opens the card on `element` once the pointer or focus has rested. */
  open: (element: HTMLElement) => void;
  /** Closes the card after the grace period, unless the pointer comes back. */
  leave: () => void;
  /** Keeps an open card open, cancelling a pending close. */
  stay: () => void;
  /** Closes the card now and keeps it shut until the pointer leaves. */
  dismiss: () => void;
  /** Closes the card now. */
  close: () => void;
}

/** Holds one hover card's open state, timers and page-wide exclusivity. */
export const useHoverCard = (): HoverCardController => {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const shown = useRef<HTMLElement | null>(null);
  const suppressed = useRef(false);
  const [owner] = useState(() => ({}));

  const clearTimers = useCallback((): void => {
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    openTimer.current = undefined;
    closeTimer.current = undefined;
  }, []);

  const close = useCallback((): void => {
    clearTimers();
    if (shown.current === null) return;
    shown.current = null;
    setAnchor(null);
    lastClosedAt = Date.now();
    if (active?.owner === owner) active = null;
  }, [clearTimers, owner]);

  const open = useCallback(
    (element: HTMLElement): void => {
      if (suppressed.current) return;
      if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
      closeTimer.current = undefined;
      if (shown.current === element) return;
      if (openTimer.current !== undefined) clearTimeout(openTimer.current);
      const warm =
        active !== null || Date.now() - lastClosedAt < WARM_WINDOW_MS;
      openTimer.current = setTimeout(
        () => {
          openTimer.current = undefined;
          if (!element.isConnected) return;
          if (active !== null && active.owner !== owner) active.close();
          active = { owner, close };
          shown.current = element;
          setAnchor(element);
        },
        warm ? HOVER_CARD_WARM_DELAY_MS : HOVER_CARD_OPEN_DELAY_MS
      );
    },
    [close, owner]
  );

  const leave = useCallback((): void => {
    suppressed.current = false;
    if (openTimer.current !== undefined) clearTimeout(openTimer.current);
    openTimer.current = undefined;
    if (shown.current === null || closeTimer.current !== undefined) return;
    closeTimer.current = setTimeout(close, HOVER_CARD_CLOSE_DELAY_MS);
  }, [close]);

  const stay = useCallback((): void => {
    if (closeTimer.current !== undefined) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  const dismiss = useCallback((): void => {
    suppressed.current = true;
    close();
  }, [close]);

  useEffect(
    () => () => {
      clearTimers();
      if (active?.owner === owner) active = null;
    },
    [clearTimers, owner]
  );

  useEffect(() => {
    if (anchor === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
    };
    const onViewport = (): void => {
      close();
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onViewport, true);
    window.addEventListener('resize', onViewport);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onViewport, true);
      window.removeEventListener('resize', onViewport);
    };
  }, [anchor, close]);

  return useMemo(
    () => ({ anchor, open, leave, stay, dismiss, close }),
    [anchor, open, leave, stay, dismiss, close]
  );
};

/** The handlers a trigger element spreads to drive its card. */
export interface HoverCardTriggerProps {
  onPointerEnter: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: (event: React.FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

/** The trigger handlers for `controller`: hover and keyboard focus open it. */
export const hoverCardTriggerProps = (
  controller: HoverCardController
): HoverCardTriggerProps => ({
  onPointerEnter: (event) => {
    if (event.pointerType === 'touch' || !canHover()) return;
    controller.open(event.currentTarget);
  },
  onPointerLeave: controller.leave,
  onPointerDown: controller.dismiss,
  onFocus: (event) => {
    if (focusIsVisible(event.currentTarget)) {
      controller.open(event.currentTarget);
    }
  },
  onBlur: controller.close,
});

/** A store subscription that never fires, so only server and client differ. */
const subscribeNothing = (): (() => void) => () => undefined;

/** Props for HoverCardPanel: its controller and what it shows for an anchor. */
export interface HoverCardPanelProps {
  controller: HoverCardController;
  /** The card content for the element it opened on. */
  children: (anchor: HTMLElement) => React.ReactNode;
  className?: string;
}

/** Stops an event inside the card reaching the trigger's own ancestors. */
const contain = (event: React.SyntheticEvent): void => {
  event.stopPropagation();
};

/** The floating card, portalled to the body while its controller is open. */
export const HoverCardPanel: React.FC<HoverCardPanelProps> = ({
  controller,
  children,
  className = '',
}) => {
  const mounted = useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false
  );
  const panel = useRef<HTMLDivElement>(null);
  const { anchor } = controller;

  const place = useCallback((): void => {
    const node = panel.current;
    if (node === null || anchor === null) return;
    const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
    const own = node.getBoundingClientRect();
    const width = document.documentElement.clientWidth || window.innerWidth;
    const height = document.documentElement.clientHeight || window.innerHeight;
    const top = placeBeside(
      rect.top,
      rect.bottom,
      own.height,
      height,
      'bottom'
    );
    const shift = shiftIntoView(rect.left, rect.left + own.width, width);
    node.style.top = `${String(top)}px`;
    node.style.left = `${String(rect.left + shift)}px`;
    node.style.visibility = 'visible';
  }, [anchor]);

  useLayoutEffect(() => {
    place();
    const node = panel.current;
    if (node === null || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [place]);

  if (!mounted || anchor === null) return null;
  return createPortal(
    <div
      ref={panel}
      data-hover-card=""
      style={UNPLACED}
      onPointerEnter={controller.stay}
      onPointerLeave={controller.leave}
      onClick={contain}
      onPointerDown={contain}
      onMouseDown={contain}
      onContextMenu={contain}
      onFocus={contain}
      onBlur={contain}
      className={cn(
        'fixed z-[65] w-80 max-w-[calc(100vw-16px)] overflow-hidden rounded-md border border-line bg-overlay text-sm shadow-overlay transition-opacity duration-100 starting:opacity-0',
        className
      )}
    >
      {children(anchor)}
    </div>,
    document.body
  );
};

/** Props for HoverCard: the trigger to draw and the card it opens. */
export interface HoverCardProps {
  /** Draws the trigger, spreading the handlers onto the element the card hangs off. */
  children: (trigger: Partial<HoverCardTriggerProps>) => React.ReactElement;
  /** The card body, rendered only while the card is open. */
  content: (anchor: HTMLElement) => React.ReactNode;
  /** Draws the trigger plain with no card, for a record that is not known. */
  disabled?: boolean;
  className?: string;
}

/**
 * One trigger and its card in a single element: the shape a person, project
 * or cycle card takes when each trigger owns its card. The body renders only
 * while the card is open, so a list of triggers reads nothing until one opens.
 */
export const HoverCard: React.FC<HoverCardProps> = ({
  children,
  content,
  disabled = false,
  className,
}) => {
  const controller = useHoverCard();
  if (disabled) return children({});
  return (
    <>
      {children(hoverCardTriggerProps(controller))}
      <HoverCardPanel
        controller={controller}
        {...(className === undefined ? {} : { className })}
      >
        {content}
      </HoverCardPanel>
    </>
  );
};
