/**
 * The sidebar layout: expanded at the default width until the viewer changes
 * it, widths clamped to the allowed range, both choices remembered in local
 * storage, shared by every reader, and held in memory when storage refuses.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readSidebarCollapsed,
  readSidebarWidth,
  resetSidebarLayout,
  useSidebarLayout,
} from './useSidebarLayout';

beforeEach(() => {
  resetSidebarLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clampSidebarWidth', () => {
  it('keeps a width within the bounds', () => {
    expect(clampSidebarWidth(120)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(250.6)).toBe(251);
  });

  it('falls back to the default for a width that is not a number', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe('useSidebarLayout', () => {
  it('starts expanded at the default width', () => {
    const { result } = renderHook(() => useSidebarLayout());

    expect(result.current.collapsed).toBe(false);
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('remembers a collapse and a width in storage', () => {
    const { result } = renderHook(() => useSidebarLayout());

    act(() => {
      result.current.toggle();
      result.current.setWidth(300);
    });

    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBe(300);
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe(
      'collapsed'
    );
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('300');
  });

  it('clamps a width it is given', () => {
    const { result } = renderHook(() => useSidebarLayout());

    act(() => {
      result.current.setWidth(1000);
    });

    expect(result.current.width).toBe(SIDEBAR_MAX_WIDTH);
  });

  it('reads stored choices on mount and clamps a stored width', () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'collapsed');
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '50');

    const { result } = renderHook(() => useSidebarLayout());

    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  it('ignores a stored width that is not a number', () => {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, 'wide');

    expect(readSidebarWidth()).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it('resets the width and forgets it', () => {
    const { result } = renderHook(() => useSidebarLayout());

    act(() => {
      result.current.setWidth(320);
    });
    act(() => {
      result.current.resetWidth();
    });

    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();
  });

  it('tells every mounted reader about a change', () => {
    const first = renderHook(() => useSidebarLayout());
    const second = renderHook(() => useSidebarLayout());

    act(() => {
      first.result.current.setCollapsed(true);
    });

    expect(second.result.current.collapsed).toBe(true);
  });

  it('holds both choices in memory when storage refuses them', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useSidebarLayout());

    expect(result.current.collapsed).toBe(false);
    expect(result.current.width).toBe(SIDEBAR_DEFAULT_WIDTH);

    act(() => {
      result.current.toggle();
      result.current.setWidth(280);
    });

    expect(result.current.collapsed).toBe(true);
    expect(result.current.width).toBe(280);
    expect(readSidebarCollapsed()).toBe(true);
  });
});
