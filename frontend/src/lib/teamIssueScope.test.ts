/**
 * The team issue presets: which preset a URL names, the status categories
 * each one narrows the list to, where a preset tab leads, and the per preset
 * display memory, which holds only display options and never overrides a
 * display the URL sets itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  parseTeamIssueScope,
  readScopeDisplay,
  scopeDisplayKey,
  teamScopeFilters,
  teamScopeHref,
  teamScopePath,
  withScopeDisplay,
  writeScopeDisplay,
} from './teamIssueScope';

beforeEach(() => {
  localStorage.clear();
});

describe('parseTeamIssueScope', () => {
  it('reads the preset the URL names', () => {
    expect(parseTeamIssueScope(new URLSearchParams('scope=active'))).toBe(
      'active'
    );
    expect(parseTeamIssueScope(new URLSearchParams('scope=backlog'))).toBe(
      'backlog'
    );
  });

  it('falls back to every issue for a missing or unknown preset', () => {
    expect(parseTeamIssueScope(new URLSearchParams())).toBe('all');
    expect(parseTeamIssueScope(new URLSearchParams('scope=done'))).toBe('all');
  });
});

describe('teamScopeFilters', () => {
  it('narrows active to the unstarted and started categories', () => {
    expect(teamScopeFilters('active')).toEqual({
      status_category: ['unstarted', 'started'],
    });
  });

  it('narrows the backlog to the backlog category', () => {
    expect(teamScopeFilters('backlog')).toEqual({
      status_category: 'backlog',
    });
  });

  it('leaves every issue unnarrowed', () => {
    expect(teamScopeFilters('all')).toEqual({});
  });
});

describe('teamScopePath', () => {
  it('names the preset in the URL, and leaves it out for every issue', () => {
    expect(teamScopePath('mine', 'ENG', 'active')).toBe(
      '/w/mine/team/ENG?scope=active'
    );
    expect(teamScopePath('mine', 'ENG', 'all')).toBe('/w/mine/team/ENG');
  });
});

describe('teamScopeHref', () => {
  it('keeps the filters, drops the display and swaps the preset', () => {
    const params = new URLSearchParams(
      'f=priority:is:high&layout=board&group=assignee&subteams=0&scope=active'
    );

    const href = teamScopeHref('/w/mine/team/ENG', params, 'backlog');
    const query = new URLSearchParams(href.split('?')[1]);

    expect(href.startsWith('/w/mine/team/ENG?')).toBe(true);
    expect(query.get('f')).toBe('priority:is:high');
    expect(query.get('subteams')).toBe('0');
    expect(query.get('scope')).toBe('backlog');
    expect(query.has('layout')).toBe(false);
    expect(query.has('group')).toBe(false);
  });

  it('leaves the preset parameter out for every issue', () => {
    expect(
      teamScopeHref(
        '/w/mine/team/ENG',
        new URLSearchParams('scope=active'),
        'all'
      )
    ).toBe('/w/mine/team/ENG');
  });
});

describe('the per preset display memory', () => {
  const active = scopeDisplayKey('team-1', 'list', 'active');
  const backlog = scopeDisplayKey('team-1', 'list', 'backlog');

  it('remembers each preset on its own', () => {
    writeScopeDisplay(
      active,
      new URLSearchParams('layout=board&group=assignee&scope=active')
    );

    expect(readScopeDisplay(active)?.toString()).toBe(
      'layout=board&group=assignee'
    );
    expect(readScopeDisplay(backlog)).toBeNull();
    expect(readScopeDisplay(scopeDisplayKey('team-2', 'list', 'active'))).toBe(
      null
    );
  });

  it('keeps no filters, and drops the entry once the display is the default', () => {
    writeScopeDisplay(active, new URLSearchParams('f=priority:is:high'));
    expect(readScopeDisplay(active)).toBeNull();

    writeScopeDisplay(active, new URLSearchParams('order=created_desc'));
    writeScopeDisplay(active, new URLSearchParams('scope=active'));
    expect(localStorage.getItem(active)).toBeNull();
  });

  it('lays a remembered display into a URL that sets none', () => {
    const next = withScopeDisplay(
      new URLSearchParams('scope=active&f=priority:is:high'),
      new URLSearchParams('layout=board')
    );

    expect(next?.get('layout')).toBe('board');
    expect(next?.get('f')).toBe('priority:is:high');
    expect(next?.get('scope')).toBe('active');
  });

  it('never overrides a display the URL sets itself', () => {
    expect(
      withScopeDisplay(
        new URLSearchParams('scope=active&group=priority'),
        new URLSearchParams('layout=board')
      )
    ).toBeNull();
    expect(withScopeDisplay(new URLSearchParams('scope=active'), null)).toBe(
      null
    );
  });
});
