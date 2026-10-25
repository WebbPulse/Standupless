/**
 * The palette's "Copy prefilled create issue URL" command on an issue page:
 * it reads the issue and copies a `/new` link carrying its team, status,
 * priority, labels, project and assignee, then confirms with a toast.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import {
  CreateIssueContext,
  type CreateIssueState,
} from '../../hooks/useCreateIssue';
import type { IssueRead } from '../../types/Api';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const showToast = vi.fn();

vi.mock('../../lib/toast', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/toast')>('../../lib/toast');
  return {
    ...actual,
    showToast: (message: string) => showToast(message),
  };
});

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    getIssueByKey: () =>
      Promise.resolve({
        id: 'issue-7',
        key: 'ENG-7',
        team_id: 'team-1',
        status_id: 'st-2',
        priority: 'high',
        label_ids: ['lb-1', 'lb-2'],
        project_id: 'prj-1',
        assignee_id: 'user-9',
      } as IssueRead),
  };
});

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
  listViews: () => Promise.resolve([]),
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

/** A create dialog the caller may use. */
const dialog: CreateIssueState = {
  open: vi.fn(),
  close: vi.fn(),
  isOpen: false,
  canCreate: true,
  request: null,
};

describe('copy prefilled create issue URL', () => {
  it('copies a /new link built from the issue on the page', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(globalThis.navigator.clipboard, 'writeText');
    render(
      <MemoryRouter initialEntries={['/w/mine/issues/ENG-7']}>
        <ShortcutProvider>
          <CreateIssueContext.Provider value={dialog}>
            <CommandPalette
              open
              onClose={vi.fn()}
              workspace={{ id: 'ws-1', slug: 'mine', role: 'owner' }}
              teams={[]}
            />
          </CreateIssueContext.Provider>
        </ShortcutProvider>
      </MemoryRouter>
    );

    await user.click(
      await screen.findByRole('option', {
        name: /Copy prefilled create issue URL/,
      })
    );

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        'Copied prefilled create issue URL'
      );
    });
    expect(writeText).toHaveBeenCalledWith(
      `${globalThis.location.origin}/w/mine/new?team=team-1&status=st-2&priority=high&assignee=user-9&labels=lb-1%2Clb-2&project=prj-1`
    );
  });
});
