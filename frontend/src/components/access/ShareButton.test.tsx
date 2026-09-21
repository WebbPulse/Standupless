/**
 * The share affordance beside a target. The token comes back on the mint and on
 * nothing else, so the URL carrying it has to be surfaced once and dropped on
 * dismiss; afterwards the settings list shows the link but never the token.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareLinkCreatedRead } from '../../types/Api';
import ShareButton from './ShareButton';

const createShareLink =
  vi.fn<(body: unknown) => Promise<ShareLinkCreatedRead>>();

vi.mock('../../api/access', () => ({
  createShareLink: (_workspaceId: string, body: unknown) =>
    createShareLink(body),
}));

/** The mint response, the one body that carries a token. */
const created: ShareLinkCreatedRead = {
  token_hash: 'hash-1',
  target_type: 'issue',
  target_id: 'iss-1',
  team_id: 'proj-1',
  title: 'Boot the engine',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: null,
  token: 'shr_abcdef',
  url: 'https://standupless.dev/shared/shr_abcdef',
};

const renderButton = () =>
  render(
    <ShareButton workspaceId="ws-1" targetType="issue" targetId="iss-1" />
  );

beforeEach(() => {
  createShareLink.mockReset();
  createShareLink.mockResolvedValue(created);
});

describe('the share button', () => {
  it('mints a link naming the target', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    await waitFor(() => {
      expect(createShareLink).toHaveBeenCalledWith({
        target_type: 'issue',
        target_id: 'iss-1',
      });
    });
  });

  it('shows the token carrying URL once, then drops it', async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(
      await screen.findByText('https://standupless.dev/shared/shr_abcdef')
    ).toBeInTheDocument();
    expect(
      screen.getByText(/can read it without signing in/)
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(
      screen.queryByText('https://standupless.dev/shared/shr_abcdef')
    ).not.toBeInTheDocument();
  });

  it('copies the link to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        'https://standupless.dev/shared/shr_abcdef'
      );
    });
  });

  it('surfaces a refused mint rather than a link', async () => {
    createShareLink.mockRejectedValue(new Error('not a writer here'));
    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByRole('button', { name: 'Share' }));

    expect(
      await screen.findByText('Could not create a share link.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/shr_abcdef/)).not.toBeInTheDocument();
  });
});
