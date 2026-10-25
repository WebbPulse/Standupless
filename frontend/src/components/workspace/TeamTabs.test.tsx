/**
 * The team surface switch: that every tab links to its own route, that the
 * showing one is marked as the current page, and that the links carry the slug
 * and key prefix they were given, and that the Releases and Documents tabs
 * leave while an admin has that area turned off.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { SidebarDataContext } from '../../contexts/SidebarDataContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { EMPTY_FAVORITES } from '../../lib/favorites';
import TeamTabs, { type TeamTab } from './TeamTabs';

/** Renders the switch for one team with `current` showing. */
const renderTabs = (current: TeamTab): void => {
  render(
    <MemoryRouter>
      <TeamTabs slug="mine" keyPrefix="ENG" current={current} />
    </MemoryRouter>
  );
};

describe('TeamTabs', () => {
  it('links each surface to its own route', () => {
    renderTabs('issues');

    expect(screen.getByRole('link', { name: 'Issues' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/board'
    );
    expect(screen.getByRole('link', { name: 'Cycles' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/cycles'
    );
    expect(screen.getByRole('link', { name: 'Releases' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/releases'
    );
    expect(screen.getByRole('link', { name: 'Documents' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/documents'
    );
    expect(screen.getByRole('link', { name: 'Standup' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/standup'
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/settings'
    );
  });

  it('marks only the showing surface as the current page', () => {
    renderTabs('board');

    expect(screen.getByRole('link', { name: 'Board' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('link', { name: 'Issues' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('carries the slug and key prefix it was given', () => {
    render(
      <MemoryRouter>
        <TeamTabs slug="other" keyPrefix="DES" current="cycles" />
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Cycles' })).toHaveAttribute(
      'href',
      '/w/other/team/DES/cycles'
    );
  });

  it('leads with Triage once the team has triage on', () => {
    render(
      <MemoryRouter>
        <SidebarDataContext.Provider
          value={{
            workspaceId: 'ws',
            triage: { teams: [{ team_id: 'team-1', count: 2 }] },
            views: null,
            inboxCount: null,
            reviews: null,
            pulseCount: null,
            favorites: EMPTY_FAVORITES,
          }}
        >
          <TeamTabs
            slug="mine"
            keyPrefix="ENG"
            teamId="team-1"
            current="issues"
          />
        </SidebarDataContext.Provider>
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Triage' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG/triage'
    );
  });

  it('leaves Triage out while the team has triage off', () => {
    renderTabs('issues');

    expect(
      screen.queryByRole('link', { name: 'Triage' })
    ).not.toBeInTheDocument();
  });

  it.each([
    ['releases', 'Releases'],
    ['documents', 'Documents'],
  ] as const)(
    'leaves out the %s tab while that area is off',
    (feature, label) => {
      render(
        <MemoryRouter>
          <WorkspaceContext.Provider
            value={{
              workspace: {
                id: 'ws',
                name: 'Mine',
                slug: 'mine',
                plan: 'free',
                created_at: '2026-09-17T00:00:00Z',
                role: 'owner',
                features: { [feature]: false },
              },
              isLoading: false,
              notFound: false,
              error: null,
              refresh: () => Promise.resolve(),
            }}
          >
            <TeamTabs slug="mine" keyPrefix="ENG" current="issues" />
          </WorkspaceContext.Provider>
        </MemoryRouter>
      );

      expect(screen.getByRole('link', { name: 'Cycles' })).toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: label })
      ).not.toBeInTheDocument();
    }
  );
});
