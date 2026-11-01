/**
 * The way back to the app is this product's binding of the shared store, whose
 * expiry and path check are tested with the package. An entry written before the
 * store moved there reads as nothing kept, which only hides the link.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { APP_HANDOFF_STORAGE_KEY, appHandoffReturn } from './pendingAppHandoff';
import { DESKTOP_HANDOFF_PATH } from './paths';

const PATH = `${DESKTOP_HANDOFF_PATH}?challenge=abc&scheme=standupless`;

afterEach(() => {
  localStorage.removeItem(APP_HANDOFF_STORAGE_KEY);
});

describe('the pending app handoff', () => {
  it('holds a path on the page this app routes', () => {
    appHandoffReturn.remember(PATH, 1000);
    expect(localStorage.getItem(APP_HANDOFF_STORAGE_KEY)).not.toBeNull();
    expect(appHandoffReturn.read(2000)).toBe(PATH);
    appHandoffReturn.clear();
    expect(appHandoffReturn.read(2000)).toBeNull();
  });

  it('reads an entry of the old shape as nothing kept', () => {
    localStorage.setItem(
      APP_HANDOFF_STORAGE_KEY,
      JSON.stringify({ path: PATH, savedAt: 1000 })
    );
    expect(appHandoffReturn.read(2000)).toBeNull();
  });
});
