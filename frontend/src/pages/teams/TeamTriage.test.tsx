/**
 * The triage inbox keys: with an issue selected, 3 and M then M both open the
 * duplicate picker, as Linear binds them, and the help sheet lists both on one
 * row.
 */

import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type { IssueRead, TeamRead } from '../../types/Api';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import TeamTriage from './TeamTriage';

const team: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

const waiting: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Login fails on Safari',
  body: null,
  status_id: 'st-todo',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-2',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

vi.mock('../../hooks/useTeam', () => ({
  useTeam: () => ({
    team,
    teams: [team],
    workspaceId: 'ws-1',
    isLoading: false,
    notFound: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const workspace: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'admin',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
};

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => workspace,
}));

vi.mock('../../api/triage', () => ({
  listTriage: () => Promise.resolve({ issues: [waiting], next_cursor: null }),
  getTriageSettings: () =>
    Promise.resolve({
      team_id: 'team-1',
      enabled: true,
      responsible_user_ids: [],
      responsibility_action: 'none',
      require_priority: false,
      updated_at: null,
    }),
  acceptTriage: vi.fn(),
  declineTriage: vi.fn(),
  duplicateTriage: vi.fn(),
  snoozeTriage: vi.fn(),
}));

vi.mock('../../api/teams', () => ({
  listStatuses: () =>
    Promise.resolve([
      { id: 'st-todo', name: 'Todo', category: 'unstarted', position: 0 },
    ]),
}));

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
  };
});

vi.mock('../../components/issues/IssuePeek', () => ({
  default: ({ issueId }: { issueId: string }) => (
    <aside aria-label={`Peek ${issueId}`} />
  ),
}));

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    children,
    actions,
  }: {
    children: ReactNode;
    actions?: ReactNode;
  }) => (
    <main>
      {actions}
      {children}
    </main>
  ),
}));

vi.mock('../../components/workspace/TeamTabs', () => ({
  default: () => null,
}));

vi.mock('../../components/workspace/TeamTitle', () => ({
  default: () => null,
}));

/** Mounts the triage route with the waiting issue selected. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/triage?i=iss-1']}>
      <ShortcutProvider>
        <BoundKeys />
        <Routes>
          <Route
            path="/w/:slug/team/:keyPrefix/triage"
            element={<TeamTriage />}
          />
        </Routes>
      </ShortcutProvider>
    </MemoryRouter>
  );

/** Presses a key on the document, as the shortcut layer hears it. */
const press = (key: string) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true })
    );
  });
};

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('TeamTriage duplicate keys', () => {
  it('opens the duplicate picker on M then M', async () => {
    renderPage();
    await screen.findByLabelText('Peek iss-1');
    await keysBound('m m', '3');

    press('m');
    press('m');

    expect(
      await screen.findByRole('dialog', { name: 'Mark as duplicate' })
    ).toBeInTheDocument();
  });

  it('opens the duplicate picker on 3', async () => {
    renderPage();
    await screen.findByLabelText('Peek iss-1');
    await keysBound('m m', '3');

    press('3');

    expect(
      await screen.findByRole('dialog', { name: 'Mark as duplicate' })
    ).toBeInTheDocument();
  });
});
