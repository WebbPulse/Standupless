/**
 * The settings index: the tier each kind of match ranks at, the order ties
 * keep, the pages a member is not offered, the anchors a section opens on, and
 * the groups the settings sidebar lists for an admin and for a member.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSettingsIndex,
  MATCH_TIER,
  rankSettings,
  settingsMatchTier,
  settingsNavGroups,
  type SettingsEntry,
} from './settingsIndex';

/** An index for workspace "mine" with one team, Engine. */
const indexFor = (role: 'owner' | 'admin' | 'member' | 'guest') =>
  buildSettingsIndex({
    workspace: { slug: 'mine', role },
    teams: [{ name: 'Engine', key_prefix: 'ENG' }],
  });

/** A bare entry for the tier tests. */
const entry = (
  id: string,
  title: string,
  synonyms: string[] = [],
  trail: string[] = []
): SettingsEntry => ({ id, title, synonyms, trail, scope: 'team', to: id });

describe('settingsMatchTier', () => {
  const length = entry(
    'length',
    'Cycle length',
    ['duration'],
    ['Engine', 'Cycles']
  );

  it('ranks an exact title first, case and punctuation blind', () => {
    expect(settingsMatchTier(length, 'Cycle length')).toBe(
      MATCH_TIER.exactTitle
    );
    expect(settingsMatchTier(length, '  cycle-LENGTH ')).toBe(
      MATCH_TIER.exactTitle
    );
  });

  it('ranks a title prefix next', () => {
    expect(settingsMatchTier(length, 'cycle')).toBe(MATCH_TIER.titlePrefix);
  });

  it('ranks every word a prefix of a title word next', () => {
    expect(settingsMatchTier(length, 'len')).toBe(MATCH_TIER.wordPrefix);
    expect(settingsMatchTier(length, 'len cyc')).toBe(MATCH_TIER.wordPrefix);
  });

  it('ranks a synonym after the title', () => {
    expect(settingsMatchTier(length, 'duration')).toBe(MATCH_TIER.synonym);
    expect(settingsMatchTier(length, 'cycle dur')).toBe(MATCH_TIER.synonym);
  });

  it('ranks a match in the section path last', () => {
    expect(settingsMatchTier(length, 'engine')).toBe(MATCH_TIER.path);
    expect(settingsMatchTier(length, 'engine length')).toBe(MATCH_TIER.path);
    expect(settingsMatchTier(length, 'ngth')).toBe(MATCH_TIER.path);
  });

  it('matches nothing on an empty term or a missing word', () => {
    expect(settingsMatchTier(length, '')).toBeNull();
    expect(settingsMatchTier(length, '   ')).toBeNull();
    expect(settingsMatchTier(length, 'billing')).toBeNull();
    expect(settingsMatchTier(length, 'cycle billing')).toBeNull();
  });
});

describe('rankSettings', () => {
  it('orders by tier and keeps index order within a tier', () => {
    const entries = [
      entry('path', 'Members', [], ['Theme park']),
      entry('synonym', 'Appearance', ['theme']),
      entry('word', 'Dark theme'),
      entry('prefix-b', 'Themes and fonts'),
      entry('prefix-a', 'Theme colors'),
      entry('exact', 'Theme'),
    ];

    expect(rankSettings(entries, 'theme').map((row) => row.id)).toEqual([
      'exact',
      'prefix-b',
      'prefix-a',
      'word',
      'synonym',
      'path',
    ]);
  });

  it('stops at the limit', () => {
    expect(rankSettings(indexFor('owner'), 'team', 3)).toHaveLength(3);
  });

  it('finds a team control by name and opens its section anchor', () => {
    const [top] = rankSettings(indexFor('owner'), 'cooldown');

    expect(top?.title).toBe('Cooldown');
    expect(top?.trail).toEqual(['Engine', 'Cycles']);
    expect(top?.to).toBe('/w/mine/team/ENG/settings#team-settings-cycles');
  });

  it('finds a personal control by a synonym', () => {
    const [top] = rankSettings(indexFor('member'), 'dark mode');

    expect(top?.title).toBe('Theme');
    expect(top?.to).toBe(
      '/w/mine/settings/account/preferences#settings-preferences'
    );
  });

  it('puts an exact page title ahead of the sections that mention it', () => {
    const [top] = rankSettings(indexFor('owner'), 'billing');

    expect(top?.id).toBe('workspace:billing');
    expect(top?.to).toBe('/w/mine/settings/billing');
  });

  it('finds API keys by a partial title', () => {
    const titles = rankSettings(indexFor('member'), 'api key')
      .slice(0, 2)
      .map((row) => row.title);

    expect(titles).toEqual(['API keys', 'API keys']);
  });

  it('ranks the same way every time', () => {
    const first = rankSettings(indexFor('owner'), 'slas').map((row) => row.id);
    const second = rankSettings(indexFor('owner'), 'slas').map((row) => row.id);

    expect(first).toEqual(second);
    expect(first[0]).toBe('team:ENG:sla');
  });
});

describe('buildSettingsIndex', () => {
  const adminPages = [
    'workspace:workspace',
    'workspace:security',
    'workspace:integrations',
    'workspace:export',
    'workspace:import',
    'workspace:audit-log',
  ];

  it('offers an owner and an admin every page and its sections', () => {
    for (const role of ['owner', 'admin'] as const) {
      const ids = indexFor(role).map((row) => row.id);
      for (const page of adminPages) expect(ids).toContain(page);
      expect(ids).toContain('workspace:security:sso');
      expect(ids).toContain('workspace:workspace:members');
    }
  });

  it('leaves the admin only pages and everything on them out for a member or guest', () => {
    for (const role of ['member', 'guest'] as const) {
      const ids = indexFor(role).map((row) => row.id);
      for (const page of adminPages) {
        expect(ids.some((id) => id === page || id.startsWith(`${page}:`))).toBe(
          false
        );
      }
      expect(ids).toContain('workspace:billing');
      expect(ids).toContain('workspace:api-keys');
      expect(ids).toContain('account:notifications');
      expect(ids).toContain('team:ENG:cycles:cooldown');
    }
  });

  it('keeps a member search away from admin pages', () => {
    expect(rankSettings(indexFor('member'), 'audit log')).toEqual([]);
    expect(
      rankSettings(indexFor('member'), 'saml').some((row) =>
        row.id.startsWith('workspace:security')
      )
    ).toBe(false);
  });

  it('covers only the teams it is given', () => {
    const ids = buildSettingsIndex({
      workspace: { slug: 'mine', role: 'owner' },
    }).map((row) => row.id);

    expect(ids.some((id) => id.startsWith('team:'))).toBe(false);
  });

  it('gives every entry a unique id and a route under the workspace', () => {
    const rows = indexFor('owner');

    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(rows.every((row) => row.to.startsWith('/w/mine/'))).toBe(true);
  });

  it('leaves out the danger zones', () => {
    expect(
      indexFor('owner').some((row) => /danger|delete/i.test(row.title))
    ).toBe(false);
  });

  it('opens a workspace section on its anchor', () => {
    const sso = indexFor('owner').find(
      (row) => row.id === 'workspace:security:sso'
    );

    expect(sso?.to).toBe('/w/mine/settings/security#settings-sso');
    expect(sso?.trail).toEqual(['Workspace', 'Security']);
  });
});

describe('settingsNavGroups', () => {
  /** The group titles and their page titles, for a role. */
  const outline = (
    role: 'owner' | 'admin' | 'member' | 'guest'
  ): Record<string, string[]> =>
    Object.fromEntries(
      settingsNavGroups(role).map((group): [string, string[]] => [
        group.title,
        group.pages.map((page) => page.title),
      ])
    );

  it('lists every group in order for an admin', () => {
    expect(settingsNavGroups('admin').map((group) => group.id)).toEqual([
      'account',
      'workspace',
      'administration',
      'features',
      'integrations',
    ]);
  });

  it('puts the admin only pages under Administration and Features', () => {
    const groups = outline('owner');
    expect(groups.Administration).toEqual(
      expect.arrayContaining(['Security', 'Export', 'Audit log'])
    );
    expect(groups.Features).toEqual(['Features']);
    expect(groups.Integrations).toEqual(
      expect.arrayContaining(['API keys', 'Integrations'])
    );
  });

  it('leaves a member no Administration or Features group but keeps Workspace', () => {
    const groups = outline('member');
    expect(Object.keys(groups)).toEqual([
      'Account',
      'Workspace',
      'Integrations',
    ]);
    expect(groups.Workspace).toEqual(
      expect.arrayContaining(['Workspace', 'Teams', 'Labels'])
    );
    expect(groups.Integrations).not.toContain('Integrations');
  });

  it('lists the workspace page for a member without offering it to search', () => {
    const memberIds = indexFor('member').map((item) => item.id);
    expect(memberIds).not.toContain('workspace:workspace');
    expect(
      settingsNavGroups('member')
        .flatMap((group) => group.pages)
        .map((page) => page.id)
    ).toContain('workspace');
  });
});
