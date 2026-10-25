/**
 * The details panel choice: shown by default, remembered in local storage,
 * shared by every mounted view, and held in memory when storage refuses it.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DETAILS_PANEL_STORAGE_KEY,
  detailsPanelTitle,
  readDetailsPanelShown,
  resetDetailsPanel,
  useDetailsPanel,
} from './useDetailsPanel';

beforeEach(() => {
  resetDetailsPanel();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDetailsPanel', () => {
  it('shows the panel until the viewer hides it', () => {
    const { result } = renderHook(() => useDetailsPanel());

    expect(result.current.shown).toBe(true);
    act(() => {
      result.current.toggle();
    });

    expect(result.current.shown).toBe(false);
    expect(localStorage.getItem(DETAILS_PANEL_STORAGE_KEY)).toBe('hidden');
  });

  it('reads a stored choice on mount', () => {
    localStorage.setItem(DETAILS_PANEL_STORAGE_KEY, 'hidden');

    const { result } = renderHook(() => useDetailsPanel());

    expect(result.current.shown).toBe(false);
  });

  it('tells every mounted view about a change', () => {
    const first = renderHook(() => useDetailsPanel());
    const second = renderHook(() => useDetailsPanel());

    act(() => {
      first.result.current.toggle();
    });

    expect(second.result.current.shown).toBe(false);
  });

  it('holds the choice in memory when storage refuses it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useDetailsPanel());

    act(() => {
      result.current.toggle();
    });

    expect(result.current.shown).toBe(false);
    expect(readDetailsPanelShown()).toBe(false);
  });

  it('names the keys in the tooltip', () => {
    expect(detailsPanelTitle(true)).toMatch(/^Hide details panel \(.+ I\)$/);
    expect(detailsPanelTitle(false)).toMatch(/^Show details panel \(.+ I\)$/);
  });
});
