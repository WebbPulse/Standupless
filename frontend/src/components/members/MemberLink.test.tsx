/**
 * MemberLink links a person to their member page inside a workspace and
 * renders plain content anywhere else, so components that name people keep
 * working in a preview or a test without a workspace. Focusing the link of a
 * known member opens their card with the profile's role, teams and local time.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MembersByIdContext } from '../../contexts/MentionMembersContextDefinition';
import {
  WorkspaceContext,
  type WorkspaceContextType,
} from '../../contexts/WorkspaceContextDefinition';
import type { MemberRead } from '../../types/Api';
import { HOVER_CARD_OPEN_DELAY_MS } from '../ui/hover-card';
import MemberLink from './MemberLink';

vi.mock('../../hooks/useMemberActivity', () => ({
  useMemberProfile: () => ({
    profile: {
      user_id: 'user-7',
      display_name: 'riley',
      role: 'admin',
      joined_at: '2026-09-17T00:00:00Z',
      team_ids: ['team-1'],
      user_status: null,
      timezone: 'Asia/Tokyo',
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: () => ({
    workspaceId: 'ws-1',
    data: [
      { id: 'team-1', name: 'Engineering', key_prefix: 'ENG' },
      { id: 'team-2', name: 'Design', key_prefix: 'DES' },
    ],
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
  }),
}));

const riley: MemberRead = {
  user_id: 'user-7',
  email: 'riley@example.com',
  display_name: 'riley',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
};

const context: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

describe('MemberLink', () => {
  it('links to the member page inside a workspace', () => {
    render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={context}>
          <MemberLink userId="user-7">Riley</MemberLink>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );

    expect(screen.getByRole('link', { name: 'Riley' })).toHaveAttribute(
      'href',
      '/w/mine/members/user-7'
    );
  });

  it('renders plain content without a workspace', () => {
    render(
      <MemoryRouter>
        <MemberLink userId="user-7">Riley</MemberLink>
      </MemoryRouter>
    );

    expect(screen.getByText('Riley')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain content without a router', () => {
    render(
      <WorkspaceContext.Provider value={context}>
        <MemberLink userId="user-7">Riley</MemberLink>
      </WorkspaceContext.Provider>
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders plain content with no person', () => {
    render(
      <MemoryRouter>
        <WorkspaceContext.Provider value={context}>
          <MemberLink userId={null}>No one</MemberLink>
        </WorkspaceContext.Provider>
      </MemoryRouter>
    );

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  describe('hover card', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('opens the member card on keyboard focus and closes on Escape', () => {
      vi.useFakeTimers();
      render(
        <MemoryRouter>
          <WorkspaceContext.Provider value={context}>
            <MembersByIdContext.Provider value={new Map([['user-7', riley]])}>
              <MemberLink userId="user-7" label="Riley">
                R
              </MemberLink>
            </MembersByIdContext.Provider>
          </WorkspaceContext.Provider>
        </MemoryRouter>
      );
      const link = screen.getByRole('link', { name: 'Riley' });
      expect(link).not.toHaveAttribute('title');
      vi.spyOn(link, 'matches').mockReturnValue(true);

      fireEvent.focus(link);
      act(() => {
        vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
      });

      expect(screen.getByTestId('member-card')).toBeInTheDocument();
      expect(screen.getByText('Admin', { exact: false })).toBeInTheDocument();
      expect(screen.getByTestId('member-local-time')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Engineering' })).toHaveAttribute(
        'href',
        '/w/mine/team/ENG'
      );
      expect(screen.queryByText('Design')).not.toBeInTheDocument();
      expect(
        screen.getByRole('link', { name: 'Assigned issues' })
      ).toHaveAttribute('href', '/w/mine/members/user-7');

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('member-card')).not.toBeInTheDocument();
    });

    it('keeps the native title for someone the member list does not know', () => {
      render(
        <MemoryRouter>
          <WorkspaceContext.Provider value={context}>
            <MemberLink userId="user-9" label="Sam">
              S
            </MemberLink>
          </WorkspaceContext.Provider>
        </MemoryRouter>
      );

      expect(screen.getByRole('link', { name: 'Sam' })).toHaveAttribute(
        'title',
        'Sam'
      );
    });
  });
});
