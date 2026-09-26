/**
 * Test helpers for pages that take keys through the shortcut registry.
 *
 * A page binds its keys in effects that run after the rows they act on have
 * committed, so a test that presses a key as soon as a row's text shows can
 * reach a registry that does not hold the key yet, and the key is dropped.
 * Rendering `BoundKeys` inside the `ShortcutProvider` and waiting on
 * {@link keysBound} before the first press closes that gap.
 */

import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/** The key sequences bound when the call is made. */
export const boundKeys = (): string[] =>
  (screen.getByTestId('bound-keys').getAttribute('data-keys') ?? '').split('|');

/** Waits until every one of the given key sequences is bound. */
export const keysBound = async (...keys: string[]): Promise<void> => {
  await waitFor(() => {
    expect(boundKeys()).toEqual(expect.arrayContaining(keys));
  });
};
