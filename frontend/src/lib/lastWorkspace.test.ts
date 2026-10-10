/**
 * The last opened workspace: that a slug is remembered and read back, that an
 * empty slug is not recorded, that unreadable storage reads as none, and that
 * only the resume state asks the picker to resume.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_WORKSPACE_STORAGE_KEY,
  RESUME_STATE,
  readLastWorkspace,
  rememberWorkspace,
  wantsResume,
} from './lastWorkspace';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem(LAST_WORKSPACE_STORAGE_KEY);
});

describe('lastWorkspace', () => {
  it('reads back the workspace last remembered', () => {
    expect(readLastWorkspace()).toBeNull();
    rememberWorkspace('mine');
    rememberWorkspace('theirs');

    expect(readLastWorkspace()).toBe('theirs');
  });

  it('does not record an empty slug', () => {
    rememberWorkspace('mine');
    rememberWorkspace('');

    expect(readLastWorkspace()).toBe('mine');
  });

  it('reads as none when storage cannot be read', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(readLastWorkspace()).toBeNull();
  });

  it('asks to resume only for the resume state', () => {
    expect(wantsResume(RESUME_STATE)).toBe(true);
    expect(wantsResume(null)).toBe(false);
    expect(wantsResume({ from: '/' })).toBe(false);
    expect(wantsResume({ resume: 'yes' })).toBe(false);
  });
});
