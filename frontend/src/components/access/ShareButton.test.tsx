/**
 * The share popover beside a target. The token comes back on the mint and on
 * nothing else, so the URL carrying it is copied at once and dropped when the
 * popover closes; the live links are listed by hash and can only be revoked.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkCreatedRead, ShareLinkRead } from '../../types/Api';
import ShareButton, { type ShareButtonProps } from './ShareButton';

const createShareLink =
  vi.fn<(body: unknown) => Promise<ShareLinkCreatedRead>>();
const listShareLinks = vi.fn<(query: unknown) => Promise<ShareLinkRead[]>>();
const revokeShareLink = vi.fn<(tokenHash: string) => Promise<void>>();

vi.mock('../../api/access', () => ({
  createShareLink: (_workspaceId: string, body: unknown) =>
    createShareLink(body),
  listShareLinks: (_workspaceId: string, query: unknown) =>
    listShareLinks(query),
  revokeShareLink: (_workspaceId: string, tokenHash: string) =>
    revokeShareLink(tokenHash),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** One listed link, the shape that carries no token. */
const listed = (over: Partial<ShareLinkRead> = {}): ShareLinkRead => ({
  token_hash: 'hash-1',
  target_type: 'issue',
  target_id: 'iss-1',
  team_id: 'team-1',
  title: 'Boot the engine',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  revoked_at: null,
  url: '/shared',
  ...over,
});

/** The mint response, the one body that carries a token. */
const created: ShareLinkCreatedRead = {
  ...listed(),
  token: 'shr_abcdef',
  url: 'https://standupless.dev/shared/shr_abcdef',
};

const renderButton = (props: Partial<ShareButtonProps> = {}) =>
  render(
    <MemoryRouter initialEntries={['/w/engineering/issues/ABC-1']}>
      <Routes>
        <Route
          path="/w/:slug/*"
          element={
            <ShareButton
              workspaceId="ws-1"
              targetType="issue"
              targetId="iss-1"
              {...props}
            />
          }
        />
      </Routes>
    </MemoryRouter>
  );

const writeText = vi.fn((_text: string) => Promise.resolve());

/** A user session whose clipboard is the spy, installed after userEvent's own. */
const setup = () => {
  const user = userEvent.setup();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  return user;
};

beforeEach(() => {
  createShareLink.mockReset();
  createShareLink.mockResolvedValue(created);
  listShareLinks.mockReset();
  listShareLinks.mockResolvedValue([]);
  revokeShareLink.mockReset();
  revokeShareLink.mockResolvedValue(undefined);
  writeText.mockClear();
});

describe('the share popover', () => {
  it('opens without minting anything', async () => {
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(screen.getByRole('dialog', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByText(/without signing in/)).toBeInTheDocument();
    expect(createShareLink).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(listShareLinks).toHaveBeenCalledWith({
        target_type: 'issue',
        target_id: 'iss-1',
      });
    });
  });

  it('mints a link naming the target and copies it at once', async () => {
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(
      screen.getByRole('button', { name: 'Create public link' })
    );

    await waitFor(() => {
      expect(createShareLink).toHaveBeenCalledWith({
        target_type: 'issue',
        target_id: 'iss-1',
      });
    });
    expect(await screen.findByLabelText('Share link')).toHaveValue(
      'https://standupless.dev/shared/shr_abcdef'
    );
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'https://standupless.dev/shared/shr_abcdef'
      );
    });
    expect(
      await screen.findByRole('button', { name: 'Copied' })
    ).toBeInTheDocument();
  });

  it('drops the token carrying URL when it closes', async () => {
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(
      screen.getByRole('button', { name: 'Create public link' })
    );
    await screen.findByLabelText('Share link');

    await user.click(document.body);
    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create public link' })
    ).toBeInTheDocument();
  });

  it('sends the snapshot for a filter share', async () => {
    const user = setup();
    renderButton({
      targetType: 'filter',
      targetId: 'team-1',
      snapshot: {
        filter: { team_id: 'team-1', priority: ['urgent'] },
        sort: 'priority_desc',
      },
    });

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(
      screen.getByRole('button', { name: 'Create public link' })
    );

    await waitFor(() => {
      expect(createShareLink).toHaveBeenCalledWith({
        target_type: 'filter',
        target_id: 'team-1',
        filter: { team_id: 'team-1', priority: ['urgent'] },
        sort: 'priority_desc',
      });
    });
  });

  it('lists live links and revokes one by hash', async () => {
    listShareLinks.mockResolvedValue([
      listed({ token_hash: 'hash-live' }),
      listed({ token_hash: 'hash-gone', revoked_at: '2026-09-19T00:00:00Z' }),
    ]);
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    const dialog = screen.getByRole('dialog', { name: 'Share' });
    const revokes = await within(dialog).findAllByRole('button', {
      name: /Revoke link/,
    });
    expect(revokes).toHaveLength(1);

    await user.click(revokes[0] as HTMLElement);
    await waitFor(() => {
      expect(revokeShareLink).toHaveBeenCalledWith('hash-live');
    });
  });

  it('points at the settings page for every link', async () => {
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(
      screen.getByRole('link', { name: 'Manage all share links' })
    ).toHaveAttribute('href', '/w/engineering/settings/share-links');
  });

  it('surfaces a refused mint rather than a link', async () => {
    createShareLink.mockRejectedValue(new Error('not a writer here'));
    const user = setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(
      screen.getByRole('button', { name: 'Create public link' })
    );

    expect(
      await screen.findByText('Could not create a share link.')
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Share link')).not.toBeInTheDocument();
  });
});
