/**
 * The card a person opens: their name and handle, the status they set with its
 * end, the away dot and note while they are away, and nothing extra for
 * someone with no status. Inside a workspace it adds the role, the local time,
 * the teams and links to their page; keyboard focus on the trigger opens it and
 * Escape closes it.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOVER_CARD_OPEN_DELAY_MS } from './hover-card';
import { MemberCard, MemberHoverTrigger } from './MemberHoverCard';

const person = {
  user_id: 'u-1',
  email: 'ann@example.com',
  display_name: 'ann',
};

describe('MemberCard', () => {
  it('shows the status and the away note for someone away', () => {
    render(
      <MemberCard
        person={{
          ...person,
          user_status: {
            emoji: '🌴',
            text: 'On vacation',
            away: true,
            until: '2099-11-02T00:00:00Z',
            set_at: '2026-10-20T00:00:00Z',
          },
        }}
      />
    );

    expect(screen.getByText('@ann')).toBeInTheDocument();
    expect(screen.getByText('On vacation')).toBeInTheDocument();
    expect(screen.getByText(/^Away until/)).toBeInTheDocument();
    expect(screen.getByTestId('avatar-away')).toBeInTheDocument();
  });

  it('shows a status that is not away with its end and no note', () => {
    render(
      <MemberCard
        person={{
          ...person,
          user_status: {
            emoji: '📅',
            text: 'In meetings',
            away: false,
            until: '2099-11-02T15:00:00Z',
            set_at: '2026-10-20T00:00:00Z',
          },
        }}
      />
    );

    expect(screen.getByText(/until/)).toBeInTheDocument();
    expect(screen.queryByText(/^Away/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('avatar-away')).not.toBeInTheDocument();
  });

  it('draws no status for someone who set none or whose status has ended', () => {
    render(
      <MemberCard
        person={{
          ...person,
          user_status: {
            emoji: '🤒',
            text: 'Out sick',
            away: true,
            until: '2001-01-01T00:00:00Z',
            set_at: '2000-12-31T00:00:00Z',
          },
        }}
      />
    );

    expect(screen.queryByText('Out sick')).not.toBeInTheDocument();
    expect(screen.queryByTestId('avatar-away')).not.toBeInTheDocument();
  });
});

describe('MemberCard details', () => {
  it('shows the role, the local time, the teams and the links', () => {
    render(
      <MemoryRouter>
        <MemberCard
          person={person}
          role="admin"
          teams={[
            { id: 't-1', name: 'Engineering', href: '/w/mine/team/ENG' },
            { id: 't-2', name: 'Design' },
          ]}
          localTime={{ time: '9:00 PM', offset: '13h ahead' }}
          links={{
            profile: '/w/mine/members/u-1',
            assigned: '/w/mine/members/u-1',
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByText('Admin', { exact: false })).toBeInTheDocument();
    expect(screen.getByTestId('member-local-time')).toHaveTextContent(
      '9:00 PM'
    );
    expect(screen.getByText(/13h ahead/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Engineering' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
    expect(screen.getByText('Design')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Assigned issues' })
    ).toHaveAttribute('href', '/w/mine/members/u-1');
    expect(screen.getByRole('link', { name: 'View profile' })).toHaveAttribute(
      'href',
      '/w/mine/members/u-1'
    );
  });

  it('leaves out the local time and teams when there are none', () => {
    render(<MemberCard person={person} />);

    expect(screen.queryByText('Local time')).not.toBeInTheDocument();
    expect(screen.queryByText('Teams')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('MemberHoverTrigger', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens on keyboard focus and closes on Escape', () => {
    vi.useFakeTimers();
    render(
      <MemberHoverTrigger person={person}>
        {(trigger) => (
          <button type="button" {...trigger}>
            ann
          </button>
        )}
      </MemberHoverTrigger>
    );
    const button = screen.getByRole('button', { name: 'ann' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.getByTestId('member-card')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('member-card')).not.toBeInTheDocument();
  });

  it('draws the trigger plain for an unknown person', () => {
    vi.useFakeTimers();
    render(
      <MemberHoverTrigger person={undefined}>
        {(trigger) => (
          <button type="button" {...trigger}>
            someone
          </button>
        )}
      </MemberHoverTrigger>
    );
    const button = screen.getByRole('button', { name: 'someone' });
    vi.spyOn(button, 'matches').mockReturnValue(true);

    fireEvent.focus(button);
    act(() => {
      vi.advanceTimersByTime(HOVER_CARD_OPEN_DELAY_MS);
    });
    expect(screen.queryByTestId('member-card')).not.toBeInTheDocument();
  });
});
