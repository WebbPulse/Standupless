/**
 * Pinning the document at its origin under the app shell: that a scroll left
 * by script is undone, that a pan the on screen keyboard needs is left alone
 * until the keyboard closes, and that nothing is touched after unmount.
 */

import { act, render } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isKeyboardHolding,
  isTextEntry,
  restoreDocumentScroll,
  usePinnedViewport,
} from './usePinnedViewport';

/** A stand-in for `window.visualViewport` whose height the test sets. */
class FakeVisualViewport extends EventTarget {
  height: number;

  constructor(height: number) {
    super();
    this.height = height;
  }
}

let scrollY = 0;
let visual: FakeVisualViewport;
const scrollTo = vi.fn(() => {
  scrollY = 0;
});

/** Moves the document as a `scrollIntoView` or a keyboard pan would. */
const scrollDocument = (to: number): void => {
  scrollY = to;
  window.dispatchEvent(new Event('scroll'));
};

/** Runs the queued animation frame callbacks. */
const flushFrames = (): void => {
  act(() => {
    vi.runOnlyPendingTimers();
  });
};

/** A component that only pins the viewport. */
const Pinned: React.FC = () => {
  usePinnedViewport();
  return <input aria-label="title" />;
};

/** Replaces a window property for one test, kept configurable to undo. */
const setWindow = (name: string, descriptor: PropertyDescriptor): void => {
  Object.defineProperty(window, name, { configurable: true, ...descriptor });
};

const saved = [
  'scrollTo',
  'visualViewport',
  'innerHeight',
  'scrollX',
  'scrollY',
].map((name) => [name, Object.getOwnPropertyDescriptor(window, name)] as const);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame'],
  });
  scrollY = 0;
  scrollTo.mockClear();
  visual = new FakeVisualViewport(800);
  setWindow('scrollTo', { value: scrollTo, writable: true });
  setWindow('visualViewport', { value: visual, writable: true });
  setWindow('innerHeight', { value: 800, writable: true });
  setWindow('scrollY', { get: () => scrollY });
  setWindow('scrollX', { get: () => 0 });
});

afterEach(() => {
  vi.useRealTimers();
  (document.activeElement as HTMLElement | null)?.blur();
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) {
      Reflect.deleteProperty(window, name);
    } else {
      Object.defineProperty(window, name, descriptor);
    }
  }
});

describe('isTextEntry', () => {
  it('counts fields that raise a keyboard and nothing else', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const readOnly = document.createElement('textarea');
    readOnly.readOnly = true;
    expect(isTextEntry(text)).toBe(true);
    expect(isTextEntry(document.createElement('textarea'))).toBe(true);
    expect(isTextEntry(checkbox)).toBe(false);
    expect(isTextEntry(readOnly)).toBe(false);
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

describe('restoreDocumentScroll', () => {
  it('leaves a document at its origin alone', () => {
    expect(restoreDocumentScroll()).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls a moved document back when no field has focus', () => {
    scrollY = 48;
    expect(restoreDocumentScroll()).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('holds the offset while a text field has focus', () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    scrollY = 48;
    expect(isKeyboardHolding()).toBe(true);
    expect(restoreDocumentScroll()).toBe(false);
    field.remove();
  });

  it('restores once the viewport grows back with the field still focused', () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    scrollY = 48;
    visual.height = 460;
    expect(restoreDocumentScroll(true)).toBe(false);
    visual.height = 800;
    expect(restoreDocumentScroll(true)).toBe(true);
    field.remove();
  });
});

describe('usePinnedViewport', () => {
  it('undoes a document scroll on the next frame', () => {
    render(<Pinned />);
    scrollDocument(60);
    expect(scrollTo).not.toHaveBeenCalled();
    flushFrames();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(window.scrollY).toBe(0);
  });

  it('waits for the keyboard to close before restoring', () => {
    const { getByLabelText } = render(<Pinned />);
    const field = getByLabelText('title');
    act(() => {
      field.focus();
    });
    visual.height = 460;
    visual.dispatchEvent(new Event('resize'));
    scrollDocument(120);
    flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();

    visual.height = 800;
    visual.dispatchEvent(new Event('resize'));
    flushFrames();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('restores when focus leaves the field', () => {
    const { getByLabelText } = render(<Pinned />);
    const field = getByLabelText('title');
    act(() => {
      field.focus();
    });
    scrollDocument(120);
    flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => {
      field.blur();
    });
    flushFrames();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('stops listening once unmounted', () => {
    const { unmount } = render(<Pinned />);
    unmount();
    scrollDocument(60);
    flushFrames();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
