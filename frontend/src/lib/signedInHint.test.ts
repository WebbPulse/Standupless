/**
 * The signed in marker: set and cleared directly, kept in step with a settled
 * session, left alone while the session is still loading, and read as absent
 * when storage is blocked.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSignedIn,
  hasSignedInHint,
  markSignedIn,
  SIGNED_IN_HINT_STORAGE_KEY,
  useSignedInHint,
} from './signedInHint';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(SIGNED_IN_HINT_STORAGE_KEY);
});

describe('signedInHint', () => {
  it('is set on sign in and cleared on sign out', () => {
    expect(hasSignedInHint()).toBe(false);
    markSignedIn();
    expect(hasSignedInHint()).toBe(true);
    clearSignedIn();
    expect(hasSignedInHint()).toBe(false);
  });

  it('follows the settled session', () => {
    const { rerender } = renderHook(
      ({ authed, loading }: { authed: boolean; loading: boolean }) =>
        useSignedInHint(authed, loading),
      { initialProps: { authed: false, loading: true } }
    );
    expect(hasSignedInHint()).toBe(false);

    rerender({ authed: true, loading: false });
    expect(hasSignedInHint()).toBe(true);

    rerender({ authed: true, loading: true });
    expect(hasSignedInHint()).toBe(true);

    rerender({ authed: false, loading: false });
    expect(hasSignedInHint()).toBe(false);
  });

  it('keeps a held marker while the session is still loading', () => {
    markSignedIn();
    renderHook(() => useSignedInHint(false, true));

    expect(hasSignedInHint()).toBe(true);
  });

  it('reads as absent when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(hasSignedInHint()).toBe(false);
  });
});
