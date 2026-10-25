/**
 * The grip on the desktop sidebar's right edge. Dragging it resizes the
 * sidebar within its bounds, the arrow keys do the same while it has focus,
 * and a double click puts the width back, as Linear's sidebar edge does.
 */

import type React from 'react';
import { useRef } from 'react';
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../hooks/useSidebarLayout';

/** How far one arrow key press moves the edge, in pixels. */
const STEP = 8;

/** How far an arrow key press with Shift moves the edge, in pixels. */
const BIG_STEP = 32;

/** Props for SidebarResizeHandle. */
export interface SidebarResizeHandleProps {
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
}

/** Renders the separator the viewer drags or nudges to resize the sidebar. */
export const SidebarResizeHandle: React.FC<SidebarResizeHandleProps> = ({
  width,
  onResize,
  onReset,
}) => {
  const drag = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width };
    const onMove = (move: PointerEvent): void => {
      if (drag.current === null) return;
      onResize(drag.current.width + move.clientX - drag.current.x);
    };
    const onUp = (): void => {
      drag.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const next =
      event.key === 'ArrowLeft'
        ? width - step
        : event.key === 'ArrowRight'
          ? width + step
          : event.key === 'Home'
            ? SIDEBAR_MIN_WIDTH
            : event.key === 'End'
              ? SIDEBAR_MAX_WIDTH
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title="Drag to resize, double click to reset"
      data-testid="sidebar-resize-handle"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group/resize absolute inset-y-0 right-0 z-10 flex w-2 cursor-col-resize touch-none justify-end outline-none"
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-transparent transition-colors group-hover/resize:bg-line-strong group-focus-visible/resize:bg-accent"
      />
    </div>
  );
};

export default SidebarResizeHandle;
