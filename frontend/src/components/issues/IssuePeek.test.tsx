/**
 * The issue peek pane. Covers that it reads the issue by id and shows its
 * title, properties and description, that a property change applies at once
 * through the same pickers as the rail, that an issue in a project can be
 * moved between the project's milestones, that it links to the full page and
 * to the issue's project and milestone, that Escape and the close button
 * dismiss it while Escape inside a picker or the comment box does not, and
 * that the issue's activity and comments show below the body, newest last,
 * with a comment box that posts and offers to sync to a linked pull request.
 */

import type { Editor } from '@tiptap/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ActivityListRead,
  CommentListRead,
  CommentRead,
  GithubThreadTargetRead,
  IssueRead,
  StatusRead,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import type { OrderedIssueRead } from '../../api/issues';
import { clearToasts } from '../../lib/toast';
import { PeekContext, type PeekState } from '../../hooks/usePeek';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
} from '../../hooks/useShortcuts';
import IssuePeek from './IssuePeek';

const getIssue = vi.fn<(id: string) => Promise<IssueRead>>();
const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listActivity = vi.fn<() => Promise<ActivityListRead>>();
const listComments = vi.fn<() => Promise<CommentListRead>>();
const createComment = vi.fn<(body: unknown) => Promise<CommentRead>>();
const listThreadTargets = vi.fn<() => Promise<GithubThreadTargetRead[]>>();
const listChildren =
  vi.fn<
    (id: string) => Promise<{ issues: OrderedIssueRead[]; next_cursor: null }>
  >();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    getIssue: (_w: string, id: string) => getIssue(id),
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
    listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
    listActivity: () => listActivity(),
    listChildren: (_w: string, id: string) => listChildren(id),
  };
});

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listComments: () => listComments(),
    createComment: (_w: string, _i: string, body: unknown) =>
      createComment(body),
    listAttachments: () =>
      Promise.resolve({ attachments: [], next_cursor: null }),
    listReactions: () => Promise.resolve([]),
  };
});

vi.mock('../../api/integrations', () => ({
  listThreadTargets: () => listThreadTargets(),
  syncThread: () => Promise.resolve({}),
  unsyncThread: () => Promise.resolve(),
}));

vi.mock('../../api/drafts', () => ({
  listIssueDrafts: () => Promise.resolve([]),
  saveDraft: () => Promise.resolve({}),
  deleteDraft: () => Promise.resolve(),
}));

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'st-2', name: 'Doing', category: 'started', position: 1 },
];

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/planning', () => ({
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
  listProjects: () => Promise.resolve({ projects: [], next_cursor: null }),
  listMilestones: () =>
    Promise.resolve([
      {
        milestone_id: 'ms-1',
        workspace_id: 'ws-1',
        project_id: 'prj-1',
        name: 'Alpha',
        description: null,
        target_date: null,
        sort_order: 'V',
        counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
        created_by: 'user-1',
        created_at: '2026-09-17T00:00:00Z',
        updated_at: '2026-09-17T00:00:00Z',
      },
    ]),
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: (): Partial<AuthContextType> => ({
    isAuthenticated: true,
    user: {
      id: 'user-1',
      email: 'someone@example.com',
      display_name: 'Someone',
      email_verified: true,
    },
  }),
}));

const team: TeamRead = {
  id: 't-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  key: 'ENG-7',
  number: 7,
  title: 'Peek at me',
  body: 'The long story',
  status_id: 'st-1',
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
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** A comment on the peeked issue. */
const comment = (overrides: Partial<CommentRead> = {}): CommentRead => ({
  comment_id: 'c-1',
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  body: 'Looks good to me',
  parent_comment_id: null,
  author_id: 'user-2',
  author: { user_id: 'user-2', display_name: 'Ada', email: 'ada@example.com' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: '2026-09-17T02:00:00Z',
  edited_at: null,
  ...overrides,
});

/** A linked pull request a thread may sync to. */
const target: GithubThreadTargetRead = {
  kind: 'pull_request',
  repository_id: 'repo-1',
  full_name: 'acme/api',
  number: 7,
  title: 'Fix the login',
  url: 'https://github.com/acme/api/pull/7',
  private: true,
  ref: 'acme/api#7',
};

/** The comment box once the lazy editor has arrived. */
const findComposer = async (): Promise<HTMLElement> =>
  screen.findByRole(
    'textbox',
    { name: 'Write a comment' },
    { timeout: 10_000 }
  );

/** The Tiptap editor behind a surface. */
const editorOf = (surface: HTMLElement): Editor =>
  (surface as HTMLElement & { editor: Editor }).editor;

/** A resolved workspace with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => ({
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: () => Promise.resolve(),
});

const onClose = vi.fn<() => void>();

const renderPeek = () =>
  render(
    <MemoryRouter>
      <IssuePeek issueId="iss-1" onClose={onClose} />
    </MemoryRouter>
  );

beforeEach(() => {
  for (const spy of [
    getIssue,
    updateIssue,
    listTeams,
    listActivity,
    listComments,
    createComment,
    listThreadTargets,
    listChildren,
    onClose,
  ])
    spy.mockReset();
  listActivity.mockResolvedValue({ activity: [], next_cursor: null });
  listComments.mockResolvedValue({ comments: [], next_cursor: null });
  listThreadTargets.mockResolvedValue([]);
  clearToasts();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  getIssue.mockResolvedValue(issue);
  updateIssue.mockImplementation((_id, body) =>
    Promise.resolve({
      ...issue,
      ...(body as object),
      updated_at: '2026-09-18T00:00:00Z',
    })
  );
  listTeams.mockResolvedValue([team]);
});

describe('IssuePeek', () => {
  it('shows the title, description and properties of the issue', async () => {
    renderPeek();

    expect(await screen.findByText('Peek at me')).toBeInTheDocument();
    expect(getIssue).toHaveBeenCalledWith('iss-1');
    expect(screen.getByText('The long story')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: 'Issue ENG-7' })
    ).toBeInTheDocument();
  });

  it('links to the full page by key', async () => {
    renderPeek();

    expect(
      await screen.findByRole('link', { name: 'Open full page' })
    ).toHaveAttribute('href', '/w/mine/issues/ENG-7');
  });

  it('applies a property change at once and writes it', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(
      await screen.findByRole('button', { name: 'Status: Todo' })
    );
    await user.keyboard('2');

    expect(
      screen.getByRole('button', { name: 'Status: Doing' })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { status_id: 'st-2' });
    });
  });

  it('moves an issue in a project to one of its milestones', async () => {
    const user = userEvent.setup();
    getIssue.mockResolvedValue({ ...issue, project_id: 'prj-1' });
    renderPeek();

    await user.click(
      await screen.findByRole('button', { name: 'Milestone: No milestone' })
    );
    await user.click(await screen.findByRole('option', { name: 'Alpha' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        project_milestone_id: 'ms-1',
      });
    });
  });

  it('links the project and milestone rows to the project page', async () => {
    getIssue.mockResolvedValue({
      ...issue,
      project_id: 'prj-1',
      project_milestone_id: 'ms-1',
    });
    renderPeek();

    expect(
      await screen.findByRole('link', { name: 'Open project' })
    ).toHaveAttribute('href', '/w/mine/projects/prj-1');
    expect(
      screen.getByRole('link', { name: 'Open milestone' })
    ).toHaveAttribute(
      'href',
      '/w/mine/projects/prj-1?tab=issues&f=milestone.is%3Ams-1'
    );
  });

  it('closes on Escape, but not while a picker is open', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(
      await screen.findByRole('button', { name: 'Status: Todo' })
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    renderPeek();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('locks the pickers for a guest without team access', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestTeam } = team;
    listTeams.mockResolvedValue([guestTeam]);
    renderPeek();

    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeDisabled();
    expect(
      await screen.findByRole('list', { name: 'Timeline' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
  });
});

describe('the peek activity feed', () => {
  it('shows activity and comments below the body, newest last', async () => {
    listActivity.mockResolvedValue({
      activity: [
        {
          activity_id: 'ac-2',
          issue_id: 'iss-1',
          kind: 'field_changed',
          field: 'status_id',
          from: 'st-1',
          to: 'st-2',
          actor_kind: 'github',
          actor_id: 'gh-1',
          created_at: '2026-09-17T03:00:00Z',
        },
        {
          activity_id: 'ac-1',
          issue_id: 'iss-1',
          kind: 'created',
          field: null,
          from: null,
          to: null,
          actor_kind: 'github',
          actor_id: 'gh-1',
          created_at: '2026-09-17T01:00:00Z',
        },
      ],
      next_cursor: null,
    });
    listComments.mockResolvedValue({
      comments: [comment()],
      next_cursor: null,
    });
    renderPeek();

    const peek = await screen.findByRole('complementary', {
      name: 'Issue ENG-7',
    });
    const timeline = await within(peek).findByRole('list', {
      name: 'Timeline',
    });
    await waitFor(() => {
      expect(timeline).toHaveTextContent('Looks good to me');
    });
    const text = timeline.textContent ?? '';
    const created = text.indexOf('created the issue');
    const commented = text.indexOf('Looks good to me');
    const changed = text.indexOf('changed the status');
    expect(created).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(commented);
    expect(commented).toBeLessThan(changed);

    const body = within(peek).getByText('The long story');
    expect(
      body.compareDocumentPosition(timeline) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      within(peek).getByRole('heading', { name: 'Activity' })
    ).toBeInTheDocument();
  });

  it('posts a comment from the composer in the peek', async () => {
    createComment.mockResolvedValue(comment({ comment_id: 'c-2' }));
    renderPeek();

    const surface = await findComposer();
    act(() => {
      editorOf(surface).commands.setContent('On it');
    });
    const send = screen.getByRole('button', { name: 'Comment' });
    await waitFor(() => {
      expect(send).toBeEnabled();
    });
    act(() => {
      fireEvent.click(send);
    });

    await waitFor(() => {
      expect(createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'On it' })
      );
    });
  });

  it('offers to sync a new thread to a linked pull request', async () => {
    listThreadTargets.mockResolvedValue([target]);
    renderPeek();

    await findComposer();
    expect(
      await screen.findByRole('button', { name: /Sync to GitHub/ })
    ).toBeInTheDocument();
  });

  it('keeps the peek open on Escape while typing a comment', async () => {
    renderPeek();

    const surface = await findComposer();
    act(() => {
      editorOf(surface).commands.setContent('Half a thought');
    });
    fireEvent.keyDown(surface, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('walking the issue tree from the peek', () => {
  /** Mounts the peek inside a shortcut registry and a peek pane. */
  const renderInPane = () => {
    const registry = createShortcutRegistry();
    const openPeek = vi.fn<PeekState['openPeek']>();
    render(
      <MemoryRouter>
        <ShortcutRegistryContext.Provider value={registry}>
          <PeekContext.Provider
            value={{
              content: { key: 'issue:ENG-7', label: 'Issue ENG-7', node: null },
              openPeek,
              closePeek: () => undefined,
            }}
          >
            <IssuePeek issueId="iss-1" onClose={onClose} />
          </PeekContext.Provider>
        </ShortcutRegistryContext.Provider>
      </MemoryRouter>
    );
    const press = (key: string): void => {
      act(() => {
        registry.handleKey(
          new KeyboardEvent('keydown', {
            key,
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });
    };
    return { openPeek, press };
  };

  it('peeks the parent in place on Ctrl+Shift+Up', async () => {
    const parent: IssueRead = {
      ...issue,
      id: 'iss-0',
      key: 'ENG-6',
      title: 'The parent',
    };
    getIssue.mockImplementation((id) =>
      Promise.resolve(
        id === 'iss-0' ? parent : { ...issue, parent_id: 'iss-0' }
      )
    );
    const { openPeek, press } = renderInPane();
    expect(await screen.findByText('Peek at me')).toBeInTheDocument();

    press('ArrowUp');

    await waitFor(() => {
      expect(openPeek).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'issue:ENG-6' })
      );
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('peeks the first sub-issue in place on Ctrl+Shift+Down', async () => {
    getIssue.mockResolvedValue({
      ...issue,
      progress: { total: 2, completed: 0 },
    });
    listChildren.mockResolvedValue({
      issues: [
        { ...issue, id: 'iss-9', key: 'ENG-9', sort_order: 'b' },
        { ...issue, id: 'iss-8', key: 'ENG-8', sort_order: 'a' },
      ],
      next_cursor: null,
    });
    const { openPeek, press } = renderInPane();
    expect(await screen.findByText('Peek at me')).toBeInTheDocument();

    press('ArrowDown');

    await waitFor(() => {
      expect(openPeek).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'issue:ENG-8' })
      );
    });
    expect(listChildren).toHaveBeenCalledWith('iss-1');
  });

  it('does nothing without a parent or sub-issues', async () => {
    const { openPeek, press } = renderInPane();
    expect(await screen.findByText('Peek at me')).toBeInTheDocument();

    press('ArrowUp');
    press('ArrowDown');

    expect(openPeek).not.toHaveBeenCalled();
    expect(listChildren).not.toHaveBeenCalled();
  });
});
