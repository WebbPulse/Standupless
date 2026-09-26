/**
 * The new issue dialog. Covers the title first flow, the property chips
 * setting only what was chosen, Cmd or Ctrl and Enter submitting, Escape
 * closing an empty draft but guarding typed text, "Create more" keeping the
 * dialog open with the properties held, and a team switch clearing the team
 * scoped choices.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueCreate,
  IssueRead,
  LabelRead,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import CreateIssueDialog from './CreateIssueDialog';

const createIssue = vi.fn<(body: IssueCreate) => Promise<IssueRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<(teamId: string) => Promise<StatusRead[]>>();

vi.mock('../../api/issues', () => ({
  createIssue: (_w: string, body: IssueCreate) => createIssue(body),
  listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: (_w: string, teamId: string) => listStatuses(teamId),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
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

/** Builds a team the caller may write to. */
const makeTeam = (id: string, name: string, prefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: prefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
});

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-2', name: 'Todo', category: 'unstarted', position: 1 },
];

const labels: LabelRead[] = [{ id: 'lb-1', name: 'bug', color: '#ef4444' }];

/** What the server answers for a created issue. */
const created = (key: string, body: IssueCreate): IssueRead => ({
  id: `id-${key}`,
  workspace_id: 'ws-1',
  team_id: body.team_id,
  key,
  number: 1,
  title: body.title,
  body: body.body ?? null,
  status_id: body.status_id ?? 'st-1',
  priority: body.priority ?? 'none',
  assignee_id: null,
  label_ids: body.label_ids ?? [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
});

const workspace: WorkspaceContextType = {
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
};

const onCreated = vi.fn<(issue: IssueRead) => void>();
const onClose = vi.fn<() => void>();
const onCreatedMore = vi.fn<(issue: IssueRead) => void>();

const renderDialog = () =>
  render(
    <WorkspaceContext.Provider value={workspace}>
      <CreateIssueDialog
        workspaceId="ws-1"
        teamId="t-1"
        estimateScale="off"
        statuses={statuses}
        labels={labels}
        people={[]}
        onCreated={onCreated}
        onClose={onClose}
        onCreatedMore={onCreatedMore}
      />
    </WorkspaceContext.Provider>
  );

let counter = 0;

beforeEach(() => {
  counter = 0;
  for (const spy of [
    createIssue,
    listTeams,
    listStatuses,
    onCreated,
    onClose,
    onCreatedMore,
  ]) {
    spy.mockReset();
  }
  listTeams.mockResolvedValue([
    makeTeam('t-1', 'Engine', 'ENG'),
    makeTeam('t-2', 'Design', 'DES'),
  ]);
  listStatuses.mockResolvedValue(statuses);
  createIssue.mockImplementation((body) => {
    counter += 1;
    return Promise.resolve(created(`ENG-${String(counter)}`, body));
  });
});

describe('filing an issue', () => {
  it('focuses the title and shows the team default status', async () => {
    renderDialog();

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveFocus();
    });
    expect(
      screen.getByRole('button', { name: 'Status: Backlog' })
    ).toBeInTheDocument();
  });

  it('sends only the title when nothing else was chosen', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
      });
    });
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ENG-1' })
    );
  });

  it('submits with Cmd or Ctrl and Enter, carrying the chosen chips', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(
      screen.getByRole('textbox', { name: 'Title' }),
      'Fix login'
    );
    await user.click(
      screen.getByRole('button', { name: 'Priority: Priority' })
    );
    await user.keyboard('1');
    await user.click(screen.getByRole('button', { name: 'Status: Backlog' }));
    await user.keyboard('2');
    await user.click(screen.getByRole('button', { name: 'Labels: Labels' }));
    await user.keyboard('{Enter}{Escape}');
    screen.getByRole('textbox', { name: 'Description' }).focus();
    await user.keyboard('Steps{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Fix login',
        body: 'Steps',
        status_id: 'st-2',
        priority: 'urgent',
        label_ids: ['lb-1'],
      });
    });
  });

  it('moves from the title to the description on Enter', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'A{Enter}');

    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveFocus();
    expect(createIssue).not.toHaveBeenCalled();
  });

  it('keeps the create button off until there is a title', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: /Create issue/ })).toBeDisabled();
  });

  it('shows a refusal and keeps the draft', async () => {
    createIssue.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.keyboard('{Meta>}{Enter}{/Meta}');

    expect(
      await screen.findByText('Could not create that issue.')
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Ship it'
    );
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe('closing', () => {
  it('closes an empty draft on Escape', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards typed text, and discards only on confirmation', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.keyboard('{Escape}');

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole('alertdialog', { name: 'Discard this issue?' })
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Draft');

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes a picker on Escape without closing the dialog', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByRole('button', { name: 'Priority: Priority' })
    );
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('create more', () => {
  it('keeps the dialog open with the properties held, and reports the last on close', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('switch', { name: 'Create more' }));
    await user.click(
      screen.getByRole('button', { name: 'Priority: Priority' })
    );
    await user.keyboard('2');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'First');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(onCreatedMore).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(onCreated).not.toHaveBeenCalled();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Second');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenLastCalledWith({
        team_id: 't-1',
        title: 'Second',
        priority: 'high',
      });
    });
    await waitFor(() => {
      expect(onCreatedMore).toHaveBeenCalledTimes(2);
    });

    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ENG-2' })
    );
  });
});

describe('switching team', () => {
  it('files into the chosen team and drops the old team choices', async () => {
    listStatuses.mockImplementation((teamId) =>
      Promise.resolve(
        teamId === 't-2'
          ? [{ id: 'st-9', name: 'Ideas', category: 'backlog', position: 0 }]
          : statuses
      )
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Status: Backlog' }));
    await user.keyboard('2');
    await user.click(
      await screen.findByRole('button', { name: 'Team: Engine' })
    );
    await user.click(screen.getByRole('option', { name: /Design/ }));

    expect(
      await screen.findByRole('button', { name: 'Status: Ideas' })
    ).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Moved');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-2',
        title: 'Moved',
      });
    });
  });
});
