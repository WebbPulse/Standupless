/**
 * The interface preferences store: that a profile with nothing stored reads as
 * the defaults, that the home view picks the page a workspace opens on, that
 * the week start moves the next week shortcut, that full names replace
 * usernames only when one is set, and that the text size paints the document.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { personLabel } from './issuePeople';
import {
  DEFAULT_PREFERENCES,
  FONT_SIZE_STORAGE_KEY,
  homeViewPath,
  preferencesOf,
  readPreferences,
  setPreferences,
  weekStartDay,
} from './preferences';
import { datePresets } from './propertyOptions';

afterEach(() => {
  setPreferences(DEFAULT_PREFERENCES);
  localStorage.removeItem(FONT_SIZE_STORAGE_KEY);
});

describe('preferences', () => {
  it('reads a profile with nothing stored as the defaults', () => {
    expect(preferencesOf(null)).toEqual(DEFAULT_PREFERENCES);
    expect(preferencesOf({ week_start: 'sunday' })).toEqual({
      ...DEFAULT_PREFERENCES,
      weekStart: 'sunday',
    });
  });

  it('reads the workflow switches, defaulting to the branch copy ones on', () => {
    expect(DEFAULT_PREFERENCES.autoAssignToSelf).toBe(false);
    expect(DEFAULT_PREFERENCES.branchCopyStarts).toBe(true);
    expect(DEFAULT_PREFERENCES.branchCopyAssigns).toBe(true);
    expect(
      preferencesOf({
        auto_assign_to_self: true,
        branch_copy_starts: false,
        branch_copy_assigns: false,
      })
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      autoAssignToSelf: true,
      branchCopyStarts: false,
      branchCopyAssigns: false,
    });
  });

  it('opens a workspace on the chosen home view', () => {
    expect(homeViewPath('acme')).toBe('/w/acme');
    expect(homeViewPath('acme', 'my_issues')).toBe('/w/acme/issues');
    setPreferences({ ...DEFAULT_PREFERENCES, homeView: 'inbox' });

    expect(homeViewPath('acme')).toBe('/w/acme/inbox');
  });

  it('starts next week on the chosen first day', () => {
    const wednesday = new Date(2026, 9, 21);
    const nextWeek = (): string | undefined =>
      datePresets(wednesday).find((preset) => preset.label === 'Next week')
        ?.value;

    expect(nextWeek()).toBe('2026-10-26');
    setPreferences({ ...DEFAULT_PREFERENCES, weekStart: 'sunday' });

    expect(weekStartDay()).toBe(0);
    expect(nextWeek()).toBe('2026-10-25');
  });

  it('shows full names only when asked and one is set', () => {
    const person = {
      user_id: 'u1',
      email: 'ada@example.com',
      display_name: 'ada',
      avatar_url: null,
      full_name: 'Ada Lovelace',
    };

    expect(personLabel(person)).toBe('ada');
    setPreferences({ ...DEFAULT_PREFERENCES, nameDisplay: 'full_name' });

    expect(personLabel(person)).toBe('Ada Lovelace');
    expect(personLabel({ ...person, full_name: '' })).toBe('ada');
  });

  it('paints and remembers the text size', () => {
    setPreferences({ ...DEFAULT_PREFERENCES, fontSize: 'large' });

    expect(readPreferences().fontSize).toBe('large');
    expect(document.documentElement.getAttribute('data-font-size')).toBe(
      'large'
    );
    expect(localStorage.getItem(FONT_SIZE_STORAGE_KEY)).toBe('large');

    setPreferences(DEFAULT_PREFERENCES);

    expect(document.documentElement.hasAttribute('data-font-size')).toBe(false);
  });

  it('paints pointer cursors only when turned on', () => {
    expect(readPreferences().pointerCursors).toBe(false);
    expect(document.documentElement.hasAttribute('data-pointer-cursors')).toBe(
      false
    );

    setPreferences({ ...DEFAULT_PREFERENCES, pointerCursors: true });

    expect(document.documentElement.hasAttribute('data-pointer-cursors')).toBe(
      true
    );

    setPreferences(DEFAULT_PREFERENCES);

    expect(document.documentElement.hasAttribute('data-pointer-cursors')).toBe(
      false
    );
  });
});
