/**
 * The create issue shortcuts: `C` opens the dialog as it is, `V` opens it
 * expanded as Linear's "Create issue in fullscreen" does, neither fires while
 * typing, and the help lists both.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import GlobalShortcuts from './GlobalShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

/** The team the workspace holds. */
const teams: TeamRead[] = [
  {
    id: 'team-1',
    workspace_id: 'ws-1',
    name: 'Engine',
    key_prefix: 'ENG',
    description: null,
    estimate_scale: 'off',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
    role: 'admin',
  },
];

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** A create issue dialog whose opener is a spy. */
const issueDialog = (): CreateIssueState => ({
  open: vi.fn(),
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
});

/** Renders the global shortcuts with the dialog given and the help when asked. */
const renderShortcuts = async (dialog: CreateIssueState, help = false) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
      <CreateIssueContext.Provider value={dialog}>
        <ShortcutProvider>
          <GlobalShortcuts
            workspace={workspace}
            teams={teams}
            onShowHelp={() => undefined}
          />
          {help && <ShortcutHelp open onClose={() => undefined} />}
          <BoundKeys />
          <input aria-label="Notes" />
        </ShortcutProvider>
      </CreateIssueContext.Provider>
    </MemoryRouter>
  );
  await keysBound('c', 'v');
  return user;
};

describe('create issue shortcuts', () => {
  it('opens the dialog as it is with C', async () => {
    const dialog = issueDialog();
    const user = await renderShortcuts(dialog);

    await user.keyboard('c');

    expect(dialog.open).toHaveBeenCalledWith();
  });

  it('opens the dialog expanded with V', async () => {
    const dialog = issueDialog();
    const user = await renderShortcuts(dialog);

    await user.keyboard('v');

    expect(dialog.open).toHaveBeenCalledWith({ expanded: true });
  });

  it('leaves V to a field being typed in', async () => {
    const dialog = issueDialog();
    const user = await renderShortcuts(dialog);

    await user.type(screen.getByRole('textbox', { name: 'Notes' }), 'v');

    expect(dialog.open).not.toHaveBeenCalled();
  });

  it('lists the fullscreen shortcut in the help', async () => {
    await renderShortcuts(issueDialog(), true);

    expect(screen.getByText('Create issue in fullscreen')).toBeInTheDocument();
  });
});
