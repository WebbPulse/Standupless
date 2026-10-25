/**
 * The palette's Leave workspace row: it opens the workspace layout's one
 * confirmation, and is absent where no layout provides one.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LeaveWorkspaceContext } from '../../hooks/useLeaveWorkspace';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
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

/** Renders the open palette, inside a Leave workspace provider when given one. */
const renderPalette = (open?: () => void): void => {
  const palette = (
    <CommandPalette
      open
      onClose={vi.fn()}
      workspace={{ id: 'ws-1', slug: 'mine', role: 'member' }}
      teams={[]}
    />
  );
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <ShortcutProvider>
        {open === undefined ? (
          palette
        ) : (
          <LeaveWorkspaceContext.Provider value={{ open }}>
            {palette}
          </LeaveWorkspaceContext.Provider>
        )}
      </ShortcutProvider>
    </MemoryRouter>
  );
};

describe('the Leave workspace row', () => {
  it('opens the shared confirmation when chosen', async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    renderPalette(open);

    await user.click(
      await screen.findByRole('option', { name: /Leave workspace/ })
    );

    await waitFor(() => {
      expect(open).toHaveBeenCalledTimes(1);
    });
  });

  it('is absent without a workspace layout to confirm in', async () => {
    renderPalette();

    expect(
      await screen.findByRole('option', { name: /Customize sidebar/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: /Leave workspace/ })
    ).not.toBeInTheDocument();
  });
});
