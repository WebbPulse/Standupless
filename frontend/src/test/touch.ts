/**
 * Fabricated finger gestures for component tests. jsdom's pointer events do
 * not reliably carry a pointer type, so each one is a mouse event with the
 * touch pointer's fields set on it, which is all React's pointer handlers
 * read.
 */

import { fireEvent } from '@testing-library/react';

/** The finger every gesture here uses. */
const POINTER_ID = 7;

/** Where a gesture starts, in viewport coordinates. */
export const START = { x: 200, y: 100 };

/** Fires one touch pointer event at a point. */
export const touchPointer = (
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  x: number,
  y: number,
  pointerType = 'touch'
): void => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pointerId', { value: POINTER_ID });
  Object.defineProperty(event, 'isPrimary', { value: true });
  fireEvent(target, event);
};

/** Slides a finger `dx` across and `dy` down from START, then lifts it. */
export const swipe = (
  target: Element,
  dx: number,
  dy = 0,
  pointerType = 'touch'
): void => {
  touchPointer(target, 'pointerdown', START.x, START.y, pointerType);
  touchPointer(
    target,
    'pointermove',
    START.x + dx / 2,
    START.y + dy / 2,
    pointerType
  );
  touchPointer(target, 'pointermove', START.x + dx, START.y + dy, pointerType);
  touchPointer(target, 'pointerup', START.x + dx, START.y + dy, pointerType);
};
