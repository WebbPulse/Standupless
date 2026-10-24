/**
 * Revealing text that an ellipsis or a line clamp cuts off. The hook hangs a
 * tooltip off the very element that truncates, so a row link whose overlay
 * covers the whole row keeps its layout, and the bubble shows the full text
 * only when the element is actually cut off at the moment it would open. A
 * hover opens it after the shared tooltip delay while the pointer rests on
 * the element's own box, and keyboard focus opens it at once. TruncatedText is
 * the plain span form for labels that are not themselves controls.
 *
 * The bubble mounts only while open, so a long list of labels carries no
 * hidden bubbles, and it repeats text that is already in the document, so
 * assistive technology reads the full label from the element itself.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { TOOLTIP_DELAY_MS, TooltipBubble, focusIsVisible } from './tooltip';

/** Whether an element's content overflows its box, across or down. */
export const isTruncated = (element: HTMLElement): boolean =>
  element.scrollWidth > element.clientWidth ||
  element.scrollHeight > element.clientHeight + 1;

/** Whether a point in client coordinates falls inside a rect. */
export const pointWithin = (rect: DOMRect, x: number, y: number): boolean =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** The handlers the truncating element takes from useTruncationTooltip. */
export interface TruncationTooltipHandlers {
  onMouseMove: (event: React.MouseEvent) => void;
  onMouseLeave: () => void;
  onPointerDown: () => void;
  onFocus: (event: React.FocusEvent) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
}

/** What useTruncationTooltip hands back: the ref, the handlers and the bubble. */
export interface TruncationTooltip<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  handlers: TruncationTooltipHandlers;
  tip: React.ReactNode;
}

/** Options for useTruncationTooltip. */
export interface TruncationTooltipOptions {
  /** The full text, when it differs from the element's own text content. */
  text?: string | undefined;
  /** Handlers the element already has, such as a prefetch, run first. */
  chain?: Partial<Record<keyof TruncationTooltipHandlers, () => void>>;
}

/**
 * A tooltip for one truncating element that opens only while it is cut off.
 * Without `text` it shows the element's own text content.
 */
export const useTruncationTooltip = <T extends HTMLElement>({
  text,
  chain = {},
}: TruncationTooltipOptions = {}): TruncationTooltip<T> => {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pressed = useRef(false);

  const clear = useCallback((): void => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const hide = useCallback((): void => {
    clear();
    setShown(null);
  }, [clear]);

  useEffect(() => clear, [clear]);

  const reveal = (): void => {
    const node = ref.current;
    if (node === null || !isTruncated(node)) return;
    const content: Node = node;
    const full = (text ?? content.textContent ?? '').trim();
    if (full !== '') setShown(full);
  };

  const handlers: TruncationTooltipHandlers = {
    onMouseMove: (event) => {
      chain.onMouseMove?.();
      const node = ref.current;
      if (node === null || pressed.current) return;
      const rect = node.getBoundingClientRect();
      if (!pointWithin(rect, event.clientX, event.clientY)) {
        hide();
        return;
      }
      if (shown !== null || timer.current !== undefined) return;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        reveal();
      }, TOOLTIP_DELAY_MS);
    },
    onMouseLeave: () => {
      chain.onMouseLeave?.();
      pressed.current = false;
      hide();
    },
    onPointerDown: () => {
      chain.onPointerDown?.();
      pressed.current = true;
      hide();
    },
    onFocus: (event) => {
      chain.onFocus?.();
      if (
        event.target === event.currentTarget &&
        !pressed.current &&
        focusIsVisible(event.currentTarget)
      )
        reveal();
    },
    onBlur: () => {
      chain.onBlur?.();
      hide();
    },
    onKeyDown: (event) => {
      chain.onKeyDown?.();
      if (event.key === 'Escape' && shown !== null) hide();
    },
  };

  const tip =
    shown === null ? null : (
      <TooltipBubble
        anchor={ref}
        open
        text={shown}
        align="start"
        wrap
        onDismiss={hide}
      />
    );

  return { ref, handlers, tip };
};

/** Props for TruncatedText: the text and any classes for its span. */
export interface TruncatedTextProps {
  children: React.ReactNode;
  /** The full text, when the children are not plain text. */
  text?: string;
  className?: string;
}

/** A single line label that ends in an ellipsis and reveals the rest on hover. */
export const TruncatedText: React.FC<TruncatedTextProps> = ({
  children,
  text,
  className,
}) => {
  const { ref, handlers, tip } = useTruncationTooltip<HTMLSpanElement>({
    text,
  });
  return (
    <>
      <span ref={ref} className={cn('truncate', className)} {...handlers}>
        {children}
      </span>
      {tip}
    </>
  );
};

export default TruncatedText;
