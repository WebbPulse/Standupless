/**
 * The workspace areas: every one reads as on until the workspace turns it
 * off, and an area that is off takes its sidebar item and its team settings
 * section with it.
 */

import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  featureOfSidebarItem,
  isFeatureOn,
  resolveFeatures,
} from './features';
import { teamSettingsDestinations } from './paletteDestinations';
import { buildSettingsIndex, teamSettingsSectionsFor } from './settingsIndex';
import { itemAvailable } from './sidebarItems';

describe('isFeatureOn', () => {
  it('reads every area as on for a workspace that names none', () => {
    for (const { feature } of FEATURES) {
      expect(isFeatureOn({}, feature)).toBe(true);
      expect(isFeatureOn(null, feature)).toBe(true);
      expect(isFeatureOn({ features: {} }, feature)).toBe(true);
    }
  });

  it('reads an area as off only when the workspace says false', () => {
    expect(isFeatureOn({ features: { releases: false } }, 'releases')).toBe(
      false
    );
    expect(isFeatureOn({ features: { releases: false } }, 'pulse')).toBe(true);
    expect(isFeatureOn({ features: { releases: true } }, 'releases')).toBe(
      true
    );
  });
});

describe('resolveFeatures', () => {
  it('fills every area the workspace leaves out as on', () => {
    expect(resolveFeatures({ features: { documents: false } })).toEqual({
      initiatives: true,
      customers: true,
      releases: true,
      documents: false,
      pulse: true,
    });
  });
});

describe('the sidebar items', () => {
  it.each(['pulse', 'initiatives', 'customers'] as const)(
    'drops %s while its area is off and keeps it while on',
    (item) => {
      expect(featureOfSidebarItem(item)).toBe(item);
      expect(itemAvailable(item, 'owner')).toBe(true);
      expect(itemAvailable(item, 'owner', {})).toBe(true);
      expect(itemAvailable(item, 'owner', { [item]: false })).toBe(false);
    }
  );

  it('keeps the items outside every area whatever is off', () => {
    const off = {
      initiatives: false,
      customers: false,
      releases: false,
      documents: false,
      pulse: false,
    };
    expect(itemAvailable('projects', 'owner', off)).toBe(true);
    expect(itemAvailable('inbox', 'owner', off)).toBe(true);
    expect(featureOfSidebarItem('projects')).toBeNull();
  });
});

describe('the team settings links', () => {
  it('offers the Releases section while releases is on', () => {
    expect(teamSettingsSectionsFor().map((row) => row.id)).toContain(
      'releases'
    );
    expect(
      teamSettingsDestinations('mine', 'ENG').map((row) => row.id)
    ).toContain('releases');
  });

  it('leaves the Releases section out of the palette and the search while releases is off', () => {
    const features = { releases: false };
    expect(
      teamSettingsDestinations('mine', 'ENG', features).map((row) => row.id)
    ).not.toContain('releases');
    const ids = buildSettingsIndex({
      workspace: { slug: 'mine', role: 'owner', features },
      teams: [{ name: 'Engine', key_prefix: 'ENG' }],
    }).map((row) => row.id);
    expect(ids).toContain('team:ENG:cycles');
    expect(ids.some((id) => id.startsWith('team:ENG:releases'))).toBe(false);
  });

  it('offers the Features page to an admin and not to a member', () => {
    const forRole = (role: 'admin' | 'member') =>
      buildSettingsIndex({ workspace: { slug: 'mine', role } }).map(
        (row) => row.id
      );
    expect(forRole('admin')).toContain('workspace:features');
    expect(forRole('member')).not.toContain('workspace:features');
  });
});
