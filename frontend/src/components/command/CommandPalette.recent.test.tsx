/**
 * The recently opened issues the palette offers: they head an empty palette
 * with their status glyph, key and title, Enter opens the newest, a typed term
 * narrows them, the issue in view is left out, its own actions come before
 * them, and only the open workspace's list shows.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useShortcut } from '../../hooks/useShortcuts';
import { issuePath } from '../../lib/paths';
import { recordRecentIssue } from '../../lib/recentIssues';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
}));

vi.mock('../../api/teams', () => ({
  listStatuses: () => Promise.resolve([]),
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** Remembers one issue for the viewer in the given workspace. */
const remember = (workspaceId: string, key: string, title: string): void => {
  recordRecentIssue(workspaceId, 'user-1', {
    id: `id-${key}`,
    key,
    title,
    team_id: 'team-1',
    status_id: 'status-1',
  });
};

/** Registers one focused-issue shortcut, as an issue page would. */
const IssueShortcut: React.FC<{ run: () => void }> = ({ run }) => {
  useShortcut({
    keys: 's',
    label: 'Change status',
    scope: 'issue',
    handler: run,
  });
  return null;
};

/** Renders the open palette for the viewer in a workspace at a path. */
const renderPalette = (
  workspaceId = 'ws-1',
  path = '/w/mine',
  issueAction?: () => void
): void => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        {issueAction === undefined ? null : <IssueShortcut run={issueAction} />}
        <CommandPalette
          open
          onClose={vi.fn()}
          workspace={{ id: workspaceId, slug: 'mine', role: 'owner' }}
          teams={[]}
          currentUserId="user-1"
        />
      </ShortcutProvider>
    </MemoryRouter>
  );
};

beforeEach(() => {
  navigate.mockReset();
  globalThis.localStorage.clear();
});

describe('recent issues in the palette', () => {
  it('lists the recent issues newest first above the commands', () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    remember('ws-1', 'ENG-2', 'Ship the billing page');
    renderPalette();

    const group = screen.getByRole('group', { name: 'Recent issues' });
    const rows = within(group).getAllByRole('option');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ship the billing page');
    expect(rows[0]).toHaveTextContent('ENG-2');
    expect(rows[1]).toHaveTextContent('Rotate the signing keys');
    expect(screen.getAllByRole('option')[0]).toBe(rows[0]);
  });

  it('opens the newest recent issue on Enter', async () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    renderPalette();

    await userEvent.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith(issuePath('mine', 'ENG-1'));
  });

  it('narrows the recent issues to the typed term', async () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    remember('ws-1', 'ENG-2', 'Ship the billing page');
    renderPalette();

    await userEvent.type(screen.getByRole('combobox'), 'billing');

    const group = screen.getByRole('group', { name: 'Recent issues' });
    const rows = within(group).getAllByRole('option');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('ENG-2');
  });

  it('shows only the open workspace recent issues', () => {
    remember('ws-2', 'OPS-1', 'Elsewhere');
    renderPalette('ws-1');

    expect(screen.queryByRole('group', { name: 'Recent issues' })).toBeNull();
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('leaves out the issue in view', () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    remember('ws-1', 'ENG-2', 'Ship the billing page');
    renderPalette('ws-1', issuePath('mine', 'ENG-2'));

    const group = screen.getByRole('group', { name: 'Recent issues' });
    const rows = within(group).getAllByRole('option');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('ENG-1');
  });

  it('puts the issue actions in view above the recent issues', async () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    const changeStatus = vi.fn();
    renderPalette('ws-1', issuePath('mine', 'ENG-2'), changeStatus);

    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveTextContent('Change status');
    const groups = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    expect(groups.indexOf('ENG-2')).toBeLessThan(
      groups.indexOf('Recent issues')
    );

    await userEvent.keyboard('{Enter}');

    expect(changeStatus).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps the recent issues first with no issue in view', async () => {
    remember('ws-1', 'ENG-1', 'Rotate the signing keys');
    const changeStatus = vi.fn();
    renderPalette('ws-1', '/w/mine', changeStatus);

    expect(screen.getAllByRole('option')[0]).toHaveTextContent(
      'Rotate the signing keys'
    );

    await userEvent.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith(issuePath('mine', 'ENG-1'));
    expect(changeStatus).not.toHaveBeenCalled();
  });
});
