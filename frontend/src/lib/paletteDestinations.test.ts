/**
 * The palette's settings destinations: which pages each role is offered, the
 * anchors a team's sections open on, and the word by word matching that lets
 * a synonym find a row.
 */

import { describe, expect, it } from 'vitest';
import {
  matchesTerm,
  settingsDestinations,
  teamSettingsDestinations,
} from './paletteDestinations';

describe('settingsDestinations', () => {
  it('offers an owner every settings page', () => {
    const ids = settingsDestinations({ slug: 'mine', role: 'owner' }).map(
      (row) => row.id
    );

    expect(ids).toContain('workspace');
    expect(ids).toContain('security');
    expect(ids).toContain('import');
    expect(ids).toContain('audit-log');
    expect(ids).toContain('notifications');
  });

  it('keeps the admin only pages from a member', () => {
    const ids = settingsDestinations({ slug: 'mine', role: 'member' }).map(
      (row) => row.id
    );

    expect(ids).not.toContain('workspace');
    expect(ids).not.toContain('security');
    expect(ids).not.toContain('integrations');
    expect(ids).not.toContain('export');
    expect(ids).not.toContain('import');
    expect(ids).not.toContain('audit-log');
    expect(ids).toContain('notifications');
    expect(ids).toContain('api-keys');
  });

  it('resolves each page under the workspace slug', () => {
    const rows = settingsDestinations({ slug: 'mine', role: 'owner' });

    expect(rows.find((row) => row.id === 'security')?.to).toBe(
      '/w/mine/settings/security'
    );
    expect(rows.find((row) => row.id === 'audit-log')?.to).toBe(
      '/w/mine/settings/audit-log'
    );
    expect(rows.every((row) => row.to.startsWith('/w/mine/settings'))).toBe(
      true
    );
  });
});

describe('teamSettingsDestinations', () => {
  it('opens every section on its anchor of the team settings page', () => {
    const rows = teamSettingsDestinations('mine', 'ENG');

    expect(rows.find((row) => row.id === 'sla')?.to).toBe(
      '/w/mine/team/ENG/settings#team-settings-sla'
    );
    expect(
      rows.every((row) =>
        row.to.startsWith('/w/mine/team/ENG/settings#team-settings-')
      )
    ).toBe(true);
  });

  it('leaves out the danger zone', () => {
    const ids = teamSettingsDestinations('mine', 'ENG').map((row) => row.id);

    expect(ids).not.toContain('danger');
  });
});

describe('matchesTerm', () => {
  it('matches everything on an empty term', () => {
    expect(matchesTerm(['Inbox'], '')).toBe(true);
    expect(matchesTerm(['Inbox'], '   ')).toBe(true);
  });

  it('needs every word, in any text and any order, case blind', () => {
    expect(matchesTerm(['SLA settings', 'team sla'], 'Team SLA')).toBe(true);
    expect(matchesTerm(['SLA settings', 'team sla'], 'sla team')).toBe(true);
    expect(matchesTerm(['SLA settings', 'team sla'], 'sla billing')).toBe(
      false
    );
  });

  it('matches a word inside a longer one', () => {
    expect(matchesTerm(['Notification settings'], 'notif')).toBe(true);
  });
});

describe('the settings index behind the palette', () => {
  it('finds the team cycle settings by a control they hold', () => {
    const rows = teamSettingsDestinations('mine', 'ENG').filter((row) =>
      matchesTerm([row.label, row.keywords], 'cooldown')
    );

    expect(rows.map((row) => row.id)).toEqual(['cycles']);
  });

  it('finds a workspace page by a section it holds', () => {
    const rows = settingsDestinations({ slug: 'mine', role: 'owner' }).filter(
      (row) => matchesTerm([row.label, row.keywords], 'single sign-on')
    );

    expect(rows.map((row) => row.id)).toContain('security');
  });
});
