/**
 * The requester of an issue that came in through Slack or email. Covers that a
 * Slack requester shows their name, handle and source, that an email requester
 * shows only the masked address, that a linked member reads as that member and
 * links to their page, and that the compact row form drops the link.
 */

import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Assignable } from '../../lib/issuePeople';
import type { IssueRequester } from '../../types/Api';
import { RequesterBadge, requesterDisplay } from './RequesterBadge';

const slack: IssueRequester = {
  source: 'slack',
  name: 'Pat Requester',
  handle: 'patr',
  avatar_url: 'https://avatars.example.com/pat.png',
  external_id: 'UAUTHOR',
  user_id: null,
};

const email: IssueRequester = {
  source: 'email',
  name: 'Alice Example',
  masked_email: 'a***@example.com',
  user_id: null,
};

const member: Assignable = {
  user_id: 'user-1',
  email: 'o***@example.com',
  display_name: 'olive',
  avatar_url: null,
  full_name: 'Olive Owner',
};

const renderBadge = (node: ReactElement) =>
  render(<MemoryRouter>{node}</MemoryRouter>);

describe('requesterDisplay', () => {
  it('shows a Slack requester by name with their handle', () => {
    expect(requesterDisplay(slack)).toEqual({
      name: 'Pat Requester',
      detail: '@patr',
      avatar: 'https://avatars.example.com/pat.png',
      memberId: null,
    });
  });

  it('falls back to the masked address when the sender gave no name', () => {
    const shown = requesterDisplay({ ...email, name: '' });
    expect(shown.name).toBe('a***@example.com');
    expect(shown.detail).toBeNull();
  });

  it('reads a linked member as that member', () => {
    const shown = requesterDisplay({ ...email, user_id: 'user-1' }, [member]);
    expect(shown.memberId).toBe('user-1');
    expect(shown.detail).toBeNull();
    expect(shown.name).not.toBe('Alice Example');
  });
});

describe('RequesterBadge', () => {
  it('names a Slack requester, their handle and the source', () => {
    renderBadge(<RequesterBadge requester={slack} />);
    expect(screen.getByText('Pat Requester')).toBeInTheDocument();
    expect(screen.getByText('@patr')).toBeInTheDocument();
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Requested by Pat Requester via Slack')
    ).toBeInTheDocument();
  });

  it('shows an email requester with only the masked address', () => {
    renderBadge(<RequesterBadge requester={email} />);
    expect(screen.getByText('a***@example.com')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.queryByText(/alice@example\.com/)).toBeNull();
  });

  it('links a linked member to their page, except in the compact row', () => {
    const linked = { ...email, user_id: 'user-1' };
    const { unmount } = renderBadge(
      <RequesterBadge requester={linked} slug="acme" people={[member]} />
    );
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/w/acme/members/user-1'
    );
    unmount();
    renderBadge(
      <RequesterBadge
        requester={linked}
        slug="acme"
        people={[member]}
        compact
      />
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
