/**
 * The card a person's mention opens: their name and handle, the status they
 * set with its end, the away dot and note while they are away, and nothing
 * extra for someone with no status.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemberCard } from './MemberHoverCard';

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
