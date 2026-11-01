/**
 * The way back to the app holds for an hour, only ever points at the handoff
 * page, and goes once it has been used.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  APP_HANDOFF_STORAGE_KEY,
  APP_HANDOFF_TTL_MS,
  clearAppHandoff,
  pendingAppHandoffPath,
  rememberAppHandoff,
} from './pendingAppHandoff';
import { DESKTOP_HANDOFF_PATH } from './paths';

const PATH = `${DESKTOP_HANDOFF_PATH}?challenge=abc&scheme=standupless`;

afterEach(() => {
  localStorage.removeItem(APP_HANDOFF_STORAGE_KEY);
});

describe('the pending app handoff', () => {
  it('answers the path it was given until it is cleared', () => {
    rememberAppHandoff(PATH, 1000);
    expect(pendingAppHandoffPath(2000)).toBe(PATH);
    clearAppHandoff();
    expect(pendingAppHandoffPath(2000)).toBeNull();
  });

  it('expires after the time limit', () => {
    rememberAppHandoff(PATH, 0);
    expect(pendingAppHandoffPath(APP_HANDOFF_TTL_MS)).toBe(PATH);
    expect(pendingAppHandoffPath(APP_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it('refuses a stored path that is not the handoff page', () => {
    rememberAppHandoff('//elsewhere.example/login', 0);
    expect(pendingAppHandoffPath(1)).toBeNull();
  });

  it('ignores an unreadable stored value', () => {
    localStorage.setItem(APP_HANDOFF_STORAGE_KEY, 'not json');
    expect(pendingAppHandoffPath()).toBeNull();
  });
});
