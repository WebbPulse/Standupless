/**
 * The saved views list. Covers moving a highlight through the rows with J and
 * K, opening the highlighted view with Enter and clearing it with Escape, the
 * highlight following the pointer, F starring the highlighted view, and
 * Cmd/Ctrl+Backspace asking to delete it only when the caller may delete it,
 * the same rule that decides whether the row's menu offers Delete.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedViewDisplayRead } from '../../api/views';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { viewPath } from '../../lib/paths';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import Views from './Views';

const listViews = vi.fn<() => Promise<SavedViewDisplayRead[]>>();
const setViewFavorite =
  vi.fn<(id: string, favorite: boolean) => Promise<SavedViewDisplayRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: 'user-1', email: 'me@example.com' },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    listViews: () => listViews(),
    setViewFavorite: (_w: string, id: string, favorite: boolean) =>
      setViewFavorite(id, favorite),
    deleteView: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../../api/insights', () => ({
  getInsights: () => Promise.resolve({ issue_count: 3 }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
}));

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [],
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

const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const workspaceContext: WorkspaceContextType = {
  workspace,
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => workspaceContext,
}));

/** A personal view, owned by the caller unless the override says otherwise. */
const viewOf = (
  id: string,
  name: string,
  override: Partial<SavedViewDisplayRead> = {}
): SavedViewDisplayRead => ({
  view_id: id,
  workspace_id: 'ws-1',
  name,
  kind: 'list',
  scope: 'personal',
  team_id: null,
  filter: {},
  sort: 'priority_desc',
  group_by: 'status',
  owner_id: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  layout: 'list',
  sub_group_by: null,
  ordering: null,
  visible_properties: null,
  show_sub_issues: true,
  show_completed: true,
  ...override,
});

const mine = viewOf('view-1', 'Mine first');
const theirs = viewOf('view-2', 'Shared by Sam', {
  scope: 'workspace',
  owner_id: 'user-2',
});

/** Prints the route, so a test can see where Enter went. */
const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const renderPage = () =>
  render(
    <ShortcutProvider>
      <MemoryRouter initialEntries={['/w/mine/views']}>
        <Routes>
          <Route path="/w/:slug/views" element={<Views />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ShortcutProvider>
  );

const rowOf = (name: string): HTMLElement => {
  const row = screen
    .getByRole('link', { name: new RegExp(name) })
    .closest('li');
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
};

beforeEach(() => {
  listViews.mockReset();
  setViewFavorite.mockReset();
  listTeams.mockReset();
  listViews.mockResolvedValue([mine, theirs]);
  listTeams.mockResolvedValue([]);
  setViewFavorite.mockImplementation((id, favorite) =>
    Promise.resolve({ ...(id === mine.view_id ? mine : theirs), favorite })
  );
});

describe('moving through the views list', () => {
  it('highlights with J and K, clears with Escape and opens with Enter', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mine first');

    await user.keyboard('j');
    expect(rowOf('Mine first')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('j');
    expect(rowOf('Mine first')).not.toHaveAttribute('aria-current');
    expect(rowOf('Shared by Sam')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('k');
    expect(rowOf('Mine first')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('{Escape}');
    expect(rowOf('Mine first')).not.toHaveAttribute('aria-current');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent(
      viewPath('mine', 'view-1')
    );
  });

  it('moves the highlight to the row under the pointer', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Shared by Sam');

    await user.hover(rowOf('Shared by Sam'));
    expect(rowOf('Shared by Sam')).toHaveAttribute('aria-current', 'true');
  });

  it('stars the highlighted view with F', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mine first');

    await user.keyboard('jf');
    await waitFor(() => {
      expect(setViewFavorite).toHaveBeenCalledWith('view-1', true);
    });
  });

  it('asks to delete the highlighted view only when the caller may', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mine first');

    await user.keyboard('j{Control>}{Backspace}{/Control}');
    expect(
      await screen.findByRole('dialog', { name: 'Delete view' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.keyboard('j{Control>}{Backspace}{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Delete view' })).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Actions for Shared by Sam' })
    );
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});
