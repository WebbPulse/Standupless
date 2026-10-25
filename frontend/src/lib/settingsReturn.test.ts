/**
 * Where leaving settings goes: the last route shown outside settings in the
 * same workspace, with its query and hash, and the workspace home otherwise.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSettingsPath,
  rememberAppRoute,
  resetSettingsReturn,
  settingsReturnPath,
} from './settingsReturn';

beforeEach(() => {
  resetSettingsReturn();
});

describe('isSettingsPath', () => {
  it('knows workspace, account and team settings', () => {
    expect(isSettingsPath('/w/mine/settings')).toBe(true);
    expect(isSettingsPath('/w/mine/settings/profile')).toBe(true);
    expect(isSettingsPath('/w/mine/team/ENG/settings')).toBe(true);
  });

  it('leaves every other page out', () => {
    expect(isSettingsPath('/w/mine')).toBe(false);
    expect(isSettingsPath('/w/mine/team/ENG/issues')).toBe(false);
    expect(isSettingsPath('/w/mine/settingsx')).toBe(false);
  });
});

describe('settingsReturnPath', () => {
  it('falls back to the workspace home', () => {
    expect(settingsReturnPath('mine')).toBe('/w/mine');
  });

  it('returns the last page outside settings with its query and hash', () => {
    rememberAppRoute('mine', '/w/mine/team/ENG/issues', '?view=board', '#top');
    rememberAppRoute('mine', '/w/mine/settings/profile');
    rememberAppRoute('mine', '/w/mine/team/ENG/settings');

    expect(settingsReturnPath('mine')).toBe(
      '/w/mine/team/ENG/issues?view=board#top'
    );
  });

  it('ignores a route from another workspace', () => {
    rememberAppRoute('mine', '/w/mine/inbox');
    rememberAppRoute('mine', '/w/other/inbox');

    expect(settingsReturnPath('mine')).toBe('/w/mine/inbox');
    expect(settingsReturnPath('other')).toBe('/w/other');
  });
});
