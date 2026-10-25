/**
 * The new issue dialog. Covers the title first flow, the property chips
 * setting only what was chosen, Cmd or Ctrl and Enter submitting, Escape
 * keeping typed text as a saved draft, or guarding it when no draft can be
 * stored, the saved draft being restored, discarded and cleared on create
 * and left alone by a preset dialog, "Create more" keeping the
 * dialog open with the properties held, and a team switch clearing the team
 * scoped choices, the similar issues strip offering to open a possible
 * duplicate or mark the new issue as one, and the auto-assign preference
 * filling the creator in as assignee, which they can still clear, and the
 * quiet line naming who on triage duty will see a new triage issue.
 */

import type { Editor } from '@tiptap/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import type {
  IssueCreate,
  IssueRead,
  LabelRead,
  LinkCreate,
  SimilarIssueRead,
  StatusRead,
  TeamRead,
  TriageSettingsRead,
} from '../../types/Api';
import type { Assignable } from '../../lib/issuePeople';
import { readIssueDraft, writeIssueDraft } from '../../lib/issueDraft';
import { DEFAULT_PREFERENCES, setPreferences } from '../../lib/preferences';
import CreateIssueDialog, { type CreateIssuePreset } from './CreateIssueDialog';

/** How long the lazily loaded editor may take to arrive on a busy runner. */
const EDITOR_LOAD_MS = 10_000;

/** The description surface once the lazy editor has arrived. */
const findDescription = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Description' },
    { timeout: EDITOR_LOAD_MS }
  );

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** Puts the caret at the end of the description and appends text. */
const typeAtEnd = (surface: HTMLElement, text: string): void => {
  act(() => {
    surface.focus();
    editorOf(surface)
      .chain()
      .setTextSelection(editorOf(surface).state.doc.content.size - 1)
      .insertContent(text)
      .run();
  });
};

const createIssue = vi.fn<(body: IssueCreate) => Promise<IssueRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<(teamId: string) => Promise<StatusRead[]>>();
const createLink =
  vi.fn<(issueId: string, body: LinkCreate) => Promise<unknown>>();
const similarIssues =
  vi.fn<
    (title: string, query?: { team_id?: string }) => Promise<SimilarIssueRead[]>
  >();

vi.mock('../../api/issues', () => ({
  createIssue: (_w: string, body: IssueCreate) => createIssue(body),
  createLink: (_w: string, issueId: string, body: LinkCreate) =>
    createLink(issueId, body),
  listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: (_w: string, teamId: string) => listStatuses(teamId),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

const triage = vi.hoisted(() => ({ on: false }));

vi.mock('../../hooks/useTriageTeams', async () => {
  const actual = await vi.importActual<
    typeof import('../../hooks/useTriageTeams')
  >('../../hooks/useTriageTeams');
  return {
    ...actual,
    useTriageOn: (teamId: string | null | undefined) =>
      triage.on && teamId === 't-1',
  };
});

const duty = vi.hoisted(() => ({
  settings: null as TriageSettingsRead | null,
}));

vi.mock('../../api/triage', () => ({
  getTriageSettings: (_w: string, teamId: string) =>
    Promise.resolve(
      duty.settings ?? {
        team_id: teamId,
        enabled: true,
        responsible_user_ids: [],
        responsibility_action: 'notify',
        require_priority: false,
        updated_at: null,
      }
    ),
}));

vi.mock('../../api/views', () => ({
  similarIssues: (_w: string, title: string, query?: { team_id?: string }) =>
    similarIssues(title, query),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: () =>
    Promise.resolve({ templates: [], default_template_id: null }),
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

const renderDialog = (
  extra: {
    currentUserId?: string;
    preset?: CreateIssuePreset;
    people?: Assignable[];
  } = {}
) =>
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
        {...extra}
      />
    </WorkspaceContext.Provider>
  );

let counter = 0;

beforeEach(() => {
  counter = 0;
  triage.on = false;
  duty.settings = null;
  setPreferences(DEFAULT_PREFERENCES);
  for (const spy of [
    createIssue,
    listTeams,
    listStatuses,
    onCreated,
    onClose,
    onCreatedMore,
    createLink,
    similarIssues,
  ]) {
    spy.mockReset();
  }
  similarIssues.mockResolvedValue([]);
  createLink.mockResolvedValue({});
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
    const description = await findDescription();
    typeAtEnd(description, 'Steps');
    act(() => {
      fireEvent.keyDown(description, { key: 'Enter', ctrlKey: true });
    });

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

    const description = await findDescription();
    await waitFor(
      () => {
        expect(description).toHaveFocus();
      },
      { timeout: EDITOR_LOAD_MS }
    );
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

describe('triage', () => {
  it('defaults the status to Triage while the team has triage on', async () => {
    triage.on = true;
    const user = userEvent.setup();
    renderDialog();

    expect(
      screen.getByRole('button', { name: 'Status: Triage' })
    ).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
      });
    });
  });

  it('files into a picked status instead of Triage', async () => {
    triage.on = true;
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: 'Status: Triage' }));
    await user.click(screen.getByRole('option', { name: /Todo/ }));
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
        status_id: 'st-2',
      });
    });
  });
});

describe('triage duty', () => {
  const PEOPLE: Assignable[] = [
    { user_id: 'u-ada', email: 'ada@example.com', display_name: 'ada' },
    { user_id: 'u-bo', email: 'bo@example.com', display_name: 'bo' },
  ];

  it('names who on triage duty will be notified', async () => {
    triage.on = true;
    duty.settings = {
      team_id: 't-1',
      enabled: true,
      responsible_user_ids: ['u-ada', 'u-bo'],
      responsibility_action: 'notify',
      require_priority: false,
      updated_at: null,
    };
    renderDialog({ people: PEOPLE });

    expect(
      await screen.findByText('Triage duty: ada and bo will be notified.')
    ).toBeInTheDocument();
  });

  it('drops the line once a status skips triage', async () => {
    triage.on = true;
    duty.settings = {
      team_id: 't-1',
      enabled: true,
      responsible_user_ids: ['u-ada'],
      responsibility_action: 'assign',
      require_priority: false,
      updated_at: null,
    };
    const user = userEvent.setup();
    renderDialog({ people: PEOPLE });

    expect(
      await screen.findByText('Triage duty: ada will be assigned this issue.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Status: Triage' }));
    await user.click(screen.getByRole('option', { name: /Todo/ }));
    expect(screen.queryByText(/Triage duty:/)).toBeNull();
  });
});

describe('closing', () => {
  it('closes an empty draft on Escape', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('guards typed text when no draft can be stored', async () => {
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

describe('drafts', () => {
  const viewer = { currentUserId: 'user-1' };

  it('keeps a dirty draft on Escape without asking, and restores it', async () => {
    const user = userEvent.setup();
    const first = renderDialog(viewer);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    typeAtEnd(await findDescription(), 'Some notes');
    await user.click(
      screen.getByRole('button', { name: 'Priority: Priority' })
    );
    await user.click(await screen.findByRole('option', { name: /High/ }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readIssueDraft('ws-1', 'user-1')).toMatchObject({
      teamId: 't-1',
      title: 'Draft',
      body: 'Some notes',
      priority: 'high',
    });

    first.unmount();
    renderDialog(viewer);

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Draft');
    expect(await findDescription()).toHaveTextContent('Some notes');
    expect(
      screen.getByRole('button', { name: 'Priority: High' })
    ).toBeInTheDocument();
  });

  it('keeps drafts apart per viewer', async () => {
    const user = userEvent.setup();
    const first = renderDialog(viewer);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Mine');
    await user.keyboard('{Escape}');
    first.unmount();
    renderDialog({ currentUserId: 'user-2' });

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });

  it('discards the draft only when asked', async () => {
    const user = userEvent.setup();
    const first = renderDialog(viewer);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Draft');
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readIssueDraft('ws-1', 'user-1')).toBeNull();

    first.unmount();
    renderDialog(viewer);
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });

  it('clears the draft once the issue is created', async () => {
    const user = userEvent.setup();
    renderDialog(viewer);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    expect(readIssueDraft('ws-1', 'user-1')).not.toBeNull();
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(readIssueDraft('ws-1', 'user-1')).toBeNull();
  });

  it('leaves a saved draft alone when opened with presets, until restored', async () => {
    const user = userEvent.setup();
    const saved = {
      teamId: 't-1',
      title: 'Saved work',
      body: 'Kept notes',
      templateId: null,
      templateTitle: '',
      templateBody: '',
      answers: {},
      statusId: '',
      priority: 'low' as const,
      assigneeId: null,
      labelIds: [],
      estimate: null,
      projectId: null,
      projectMilestoneId: null,
      cycleId: null,
      startDate: null,
      dueDate: null,
      parent: null,
      subIssues: [],
    };
    writeIssueDraft('ws-1', 'user-1', saved);
    renderDialog({ ...viewer, preset: { statusId: 'st-2' } });

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(
      screen.getByRole('status', { name: 'Saved draft' })
    ).toHaveTextContent('Saved work');

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Other');
    expect(readIssueDraft('ws-1', 'user-1')).toMatchObject({
      title: 'Saved work',
    });
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole('alertdialog', { name: 'Discard this issue?' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));

    await user.click(screen.getByRole('button', { name: 'Restore draft' }));

    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue(
      'Saved work'
    );
    const description = await findDescription();
    await waitFor(() => {
      expect(description).toHaveTextContent('Kept notes');
    });
    expect(
      screen.getByRole('button', { name: 'Priority: Low' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('status', { name: 'Saved draft' })
    ).not.toBeInTheDocument();
  });

  it('starts fresh when the saved draft is set aside', async () => {
    const user = userEvent.setup();
    writeIssueDraft('ws-1', 'user-1', {
      teamId: 't-1',
      title: 'Saved work',
      body: '',
      templateId: null,
      templateTitle: '',
      templateBody: '',
      answers: {},
      statusId: '',
      priority: 'none',
      assigneeId: null,
      labelIds: [],
      estimate: null,
      projectId: null,
      projectMilestoneId: null,
      cycleId: null,
      startDate: null,
      dueDate: null,
      parent: null,
      subIssues: [],
    });
    renderDialog({ ...viewer, preset: { statusId: 'st-2' } });

    await user.click(
      screen.getByRole('button', { name: 'Discard saved draft' })
    );
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'New');
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(readIssueDraft('ws-1', 'user-1')).toMatchObject({
      title: 'New',
      statusId: 'st-2',
    });
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

const lookalike: SimilarIssueRead = {
  issue_id: 'id-ENG-7',
  key: 'ENG-7',
  title: 'Login redirect broken on Safari',
  team_id: 't-1',
  status_id: 'st-2',
  status_name: 'Todo',
  status_category: 'unstarted',
  status_color: null,
  status_icon: null,
  score: 2,
};

describe('similar issues', () => {
  it('lists possible duplicates once the title holds a searchable word', async () => {
    similarIssues.mockResolvedValue([lookalike]);
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Fix');
    await user.type(
      screen.getByRole('textbox', { name: 'Title' }),
      ' login redirect'
    );

    const strip = await screen.findByRole('region', {
      name: 'Similar issues',
    });
    expect(strip).toHaveTextContent('ENG-7');
    expect(
      screen.getByRole('link', { name: 'Login redirect broken on Safari' })
    ).toHaveAttribute('href', '/w/mine/issues/ENG-7');
    expect(similarIssues).toHaveBeenCalledTimes(1);
    expect(similarIssues).toHaveBeenCalledWith(
      'Fix login redirect',
      expect.objectContaining({ team_id: 't-1' })
    );
  });

  it('marks the new issue a duplicate of the chosen one on create', async () => {
    similarIssues.mockResolvedValue([lookalike]);
    const user = userEvent.setup();
    renderDialog();

    await user.type(
      screen.getByRole('textbox', { name: 'Title' }),
      'Login redirect fails'
    );
    await user.click(
      await screen.findByRole('button', {
        name: 'Mark as duplicate of ENG-7',
      })
    );
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createLink).toHaveBeenCalledWith('id-ENG-1', {
        type: 'duplicate_of',
        target_issue_id: 'id-ENG-7',
      });
    });
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'ENG-1' })
    );
  });
});

describe('auto-assign to self', () => {
  const creator = { currentUserId: 'user-auto' };

  it('leaves the assignee empty while the preference is off', async () => {
    const user = userEvent.setup();
    renderDialog(creator);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
      });
    });
  });

  it('files the issue assigned to the creator while it is on', async () => {
    setPreferences({ ...DEFAULT_PREFERENCES, autoAssignToSelf: true });
    const user = userEvent.setup();
    renderDialog(creator);

    expect(
      screen.queryByRole('button', { name: 'Assignee: Assignee' })
    ).not.toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
        assignee_id: 'user-auto',
      });
    });
  });

  it('keeps an assignee the preset names', async () => {
    setPreferences({ ...DEFAULT_PREFERENCES, autoAssignToSelf: true });
    const user = userEvent.setup();
    renderDialog({ ...creator, preset: { assigneeId: 'user-other' } });

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ assignee_id: 'user-other' })
      );
    });
  });

  it('lets the creator clear the filled in assignee', async () => {
    setPreferences({ ...DEFAULT_PREFERENCES, autoAssignToSelf: true });
    const user = userEvent.setup();
    renderDialog(creator);

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship it');
    await user.click(screen.getByRole('button', { name: /^Assignee:/ }));
    await user.click(
      await screen.findByRole('option', { name: /No assignee/ })
    );
    expect(
      screen.getByRole('button', { name: 'Assignee: Assignee' })
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship it',
      });
    });
  });
});
