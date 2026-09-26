/**
 * Keyboard movement through a list. Covers that j/k and the arrows move, that
 * Enter opens, Space peeks and Escape clears, that the highlight clamps rather than wraps,
 * and that the handler stands down while someone is typing or holding a
 * modifier, since the list shares the document with the command palette.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useListKeyboardNav } from './useListKeyboardNav';

const press = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init })
    );
  });
};

const pressFrom = (target: Element, key: string) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};

const onActivate = vi.fn<(index: number) => void>();

beforeEach(() => {
  onActivate.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('moving the highlight', () => {
  it('starts with nothing highlighted', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    expect(result.current.activeIndex).toBe(-1);
  });

  it('moves down on j and on ArrowDown', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    press('j');
    expect(result.current.activeIndex).toBe(0);

    press('ArrowDown');
    expect(result.current.activeIndex).toBe(1);
  });

  it('moves up on k and on ArrowUp', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    press('j');
    press('j');
    expect(result.current.activeIndex).toBe(1);

    press('k');
    expect(result.current.activeIndex).toBe(0);

    press('j');
    press('ArrowUp');
    expect(result.current.activeIndex).toBe(0);
  });

  it('enters the list at the last row when the first move is upward', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    press('k');

    expect(result.current.activeIndex).toBe(2);
  });

  it('clamps at the bottom rather than wrapping', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 2, onActivate })
    );

    press('j');
    press('j');
    press('j');

    expect(result.current.activeIndex).toBe(1);
  });

  it('clamps at the top rather than wrapping', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 2, onActivate })
    );

    press('j');
    press('k');
    press('k');

    expect(result.current.activeIndex).toBe(0);
  });

  it('takes the highlight from the pointer', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    act(() => {
      result.current.setActiveIndex(2);
    });

    expect(result.current.activeIndex).toBe(2);
  });
});

describe('opening and clearing', () => {
  it('opens the highlighted row on Enter', () => {
    renderHook(() => useListKeyboardNav({ count: 3, onActivate }));

    press('j');
    press('j');
    press('Enter');

    expect(onActivate).toHaveBeenCalledWith(1);
  });

  it('opens nothing when no row is highlighted', () => {
    renderHook(() => useListKeyboardNav({ count: 3, onActivate }));

    press('Enter');

    expect(onActivate).not.toHaveBeenCalled();
  });

  it('clears the highlight on Escape', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    press('j');
    press('Escape');

    expect(result.current.activeIndex).toBe(-1);
  });
});

describe('standing down', () => {
  it('ignores the keys while someone is typing in an input', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );
    const input = document.createElement('input');
    document.body.append(input);

    pressFrom(input, 'j');

    expect(result.current.activeIndex).toBe(-1);
  });

  it('ignores the keys while someone is typing in a textarea', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );
    const area = document.createElement('textarea');
    document.body.append(area);

    pressFrom(area, 'k');

    expect(result.current.activeIndex).toBe(-1);
  });

  it('ignores the keys inside a contenteditable', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );
    const box = document.createElement('div');
    box.contentEditable = 'true';
    Object.defineProperty(box, 'isContentEditable', { value: true });
    document.body.append(box);

    pressFrom(box, 'j');

    expect(result.current.activeIndex).toBe(-1);
  });

  it('leaves a held modifier to whatever owns that shortcut', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );

    press('j', { metaKey: true });
    press('j', { ctrlKey: true });
    press('ArrowDown', { altKey: true });

    expect(result.current.activeIndex).toBe(-1);
  });

  it('does not open on a modifier held Enter', () => {
    renderHook(() => useListKeyboardNav({ count: 3, onActivate }));

    press('j');
    press('Enter', { metaKey: true });

    expect(onActivate).not.toHaveBeenCalled();
  });

  it('listens to nothing while disabled', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate, enabled: false })
    );

    press('j');

    expect(result.current.activeIndex).toBe(-1);
  });

  it('listens to nothing in an empty list', () => {
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 0, onActivate })
    );

    press('j');

    expect(result.current.activeIndex).toBe(-1);
  });
});

describe('when the list changes underneath', () => {
  it('drops the highlight when the reset key changes', () => {
    const { result, rerender } = renderHook(
      ({ resetKey }: { resetKey: string }) =>
        useListKeyboardNav({ count: 3, onActivate, resetKey }),
      { initialProps: { resetKey: 'first' } }
    );

    press('j');
    expect(result.current.activeIndex).toBe(0);

    rerender({ resetKey: 'second' });

    expect(result.current.activeIndex).toBe(-1);
  });

  it('drops a highlight the list has shrunk past', () => {
    const { result, rerender } = renderHook(
      ({ count }: { count: number }) =>
        useListKeyboardNav({ count, onActivate }),
      { initialProps: { count: 5 } }
    );

    press('k');
    expect(result.current.activeIndex).toBe(4);

    rerender({ count: 2 });

    expect(result.current.activeIndex).toBe(-1);
  });
});

describe('keeping the highlight in view', () => {
  it('scrolls the highlighted row into view', () => {
    const scrollIntoView = vi.fn();
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );
    const row = document.createElement('li');
    row.scrollIntoView = scrollIntoView;

    act(() => {
      result.current.registerItem(0)(row);
    });
    press('j');

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('forgets a row that has left the list', () => {
    const scrollIntoView = vi.fn();
    const { result } = renderHook(() =>
      useListKeyboardNav({ count: 3, onActivate })
    );
    const row = document.createElement('li');
    row.scrollIntoView = scrollIntoView;

    act(() => {
      result.current.registerItem(0)(row);
      result.current.registerItem(0)(null);
    });
    press('j');

    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('peeking', () => {
  it('peeks the highlighted row on Space', () => {
    const onPeek = vi.fn<(index: number) => void>();
    renderHook(() => useListKeyboardNav({ count: 3, onActivate, onPeek }));

    press('j');
    press('j');
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(onPeek).toHaveBeenCalledWith(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Space to the page when the list cannot peek', () => {
    renderHook(() => useListKeyboardNav({ count: 3, onActivate }));

    press('j');
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not peek with nothing highlighted', () => {
    const onPeek = vi.fn<(index: number) => void>();
    renderHook(() => useListKeyboardNav({ count: 3, onActivate, onPeek }));

    press(' ');

    expect(onPeek).not.toHaveBeenCalled();
  });
});
