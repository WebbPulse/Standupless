/**
 * The issue detail page. Covers resolving the key through the by-key read, the
 * inline pickers each sending their own PATCH and showing the change before it
 * lands, the rollback when a write fails, the rail sections for the parent,
 * sub-issues, relations and links, the issue menu that adds them, the unified
 * timeline, and the capability gate that hides every control.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ActivityListRead,
  IssueListRead,
  IssueRead,
  LabelRead,
  LinkRead,
  TeamMemberRead,
  TeamRead,
  StatusRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import { clearToasts } from '../../lib/toast';
import IssueDetail from './IssueDetail';

const getIssueByKey = vi.fn<() => Promise<IssueRead>>();
const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listChildren = vi.fn<() => Promise<IssueListRead>>();
const listLinks = vi.fn<() => Promise<LinkRead[]>>();
const createLink = vi.fn<(body: unknown) => Promise<LinkRead>>();
const deleteLink = vi.fn<(linkId: string) => Promise<void>>();
const listActivity = vi.fn<() => Promise<ActivityListRead>>();

const listTeams = vi.fn<() => Promise<TeamRead[]>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const listTeamMembers = vi.fn<() => Promise<TeamMemberRead[]>>();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    getIssueByKey: () => getIssueByKey(),
    updateIssue: (_w: string, id: string, body: unknown) =>
      updateIssue(id, body),
    listIssues: (_w: string, query: unknown) => listIssues(query),
    listChildren: () => listChildren(),
    listLinks: () => listLinks(),
    createLink: (_w: string, _i: string, body: unknown) => createLink(body),
    deleteLink: (_w: string, _i: string, linkId: string) => deleteLink(linkId),
    listActivity: () => listActivity(),
  };
});

const createLabel = vi.fn<(body: unknown) => Promise<LabelRead>>();

vi.mock('../../api/teams', () => ({
  listTeams: () => listTeams(),
  listStatuses: () => listStatuses(),
  listLabels: () => listLabels(),
  listTeamMembers: () => listTeamMembers(),
  createLabel: (_w: string, _t: string, body: unknown) => createLabel(body),
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listComments: () => Promise.resolve({ comments: [], next_cursor: null }),
    listAttachments: () =>
      Promise.resolve({ attachments: [], next_cursor: null }),
    listReactions: () => Promise.resolve([]),
  };
});

/** A settled signed in session, which is the only state this page renders in. */
const session = (): AuthContextType => ({
  isAuthenticated: true,
  isLoading: false,
  isBusy: false,
  user: {
    id: 'user-1',
    email: 'someone@example.com',
    display_name: 'Someone',
    email_verified: true,
  },
  login: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  checkAuthStatus: vi.fn(() => Promise.resolve()),
});

/** The team the issue belongs to, on the fibonacci scale so estimates show. */
const team: TeamRead = {
  id: 'proj-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'fibonacci',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'member',
};

/** Two statuses, so the status select has something to change to. */
const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Todo', category: 'unstarted', position: 0 },
  { id: 'st-2', name: 'Doing', category: 'started', position: 1 },
];

/** One label, so the label checkboxes render. */
const label: LabelRead = { id: 'lb-1', name: 'bug', color: '#ef4444' };

/** One team member, so the assignee select has a person on it. */
const member: TeamMemberRead = {
  user_id: 'user-2',
  email: 'other@example.com',
  display_name: 'Other',
  role: 'member',
  added_at: '2026-09-17T00:00:00Z',
};

/** The issue the route resolves to, with two children done out of four. */
const issue: IssueRead = {
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'proj-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: 'Some **markdown** body',
  status_id: 'st-1',
  priority: 'high',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 4, completed: 2 },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
};

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** Mounts the key route, which is the address this page answers. */
const renderPage = (key = 'ENG-1') =>
  render(
    <MemoryRouter initialEntries={[`/w/mine/issues/${key}`]}>
      <Routes>
        <Route path="/w/:slug/issues/:key" element={<IssueDetail />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  for (const spy of [
    getIssueByKey,
    updateIssue,
    listIssues,
    listChildren,
    listLinks,
    createLink,
    deleteLink,
    listActivity,
    listTeams,
    listStatuses,
    listLabels,
    listTeamMembers,
    createLabel,
  ]) {
    spy.mockReset();
  }
  clearToasts();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue(session());
  getIssueByKey.mockResolvedValue(issue);
  updateIssue.mockResolvedValue(issue);
  listIssues.mockResolvedValue({ issues: [], next_cursor: null });
  listChildren.mockResolvedValue({ issues: [], next_cursor: null });
  listLinks.mockResolvedValue([]);
  listActivity.mockResolvedValue({ activity: [], next_cursor: null });
  listTeams.mockResolvedValue([team]);
  listStatuses.mockResolvedValue(statuses);
  listLabels.mockResolvedValue([label]);
  listTeamMembers.mockResolvedValue([member]);
});

describe('resolving the issue', () => {
  it('reads the issue by the key in the route', async () => {
    renderPage();

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(getIssueByKey).toHaveBeenCalled();
  });

  it('links back to the team the issue belongs to', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'Engine' })).toHaveAttribute(
      'href',
      '/w/mine/team/ENG'
    );
  });

  it('surfaces a failed read', async () => {
    getIssueByKey.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load this issue.')
    ).toBeInTheDocument();
  });
});

describe('editing the title and description', () => {
  it('saves a new title as its own patch', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit title' }));
    const field = screen.getByLabelText('Title');
    await user.clear(field);
    await user.type(field, 'Cache the refresh token');
    await user.click(screen.getByRole('button', { name: 'Save title' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        title: 'Cache the refresh token',
      });
    });
  });

  it('refuses to save a title past the contract limit', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Edit title' }));
    const field = screen.getByLabelText('Title');
    await user.clear(field);
    await user.paste('x'.repeat(201));

    expect(screen.getByRole('button', { name: 'Save title' })).toBeDisabled();
  });

  it('renders the description as Markdown, in view and in the preview', async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText('markdown', { selector: 'strong' })
    ).toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: 'Edit description' })
    );

    expect(screen.getByLabelText('Description')).toHaveValue(
      'Some **markdown** body'
    );
    expect(
      screen.getByText('markdown', { selector: 'strong' })
    ).toBeInTheDocument();
  });

  it('clears the description to null rather than an empty string', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Edit description' })
    );
    await user.clear(screen.getByLabelText('Description'));
    await user.click(screen.getByRole('button', { name: 'Save description' }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { body: null });
    });
  });
});

describe('editing the fields', () => {
  /** Opens a rail picker once the lists it offers have loaded. */
  const openPicker = async (
    user: ReturnType<typeof userEvent.setup>,
    name: RegExp | string
  ) => {
    const trigger = await screen.findByRole('button', { name });
    await user.click(trigger);
    return trigger;
  };

  it('saves a status change on its own and shows it at once', async () => {
    let finish: (value: IssueRead) => void = () => undefined;
    updateIssue.mockImplementation(
      () =>
        new Promise<IssueRead>((resolve) => {
          finish = resolve;
        })
    );
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, 'Status: Todo');
    await user.click(await screen.findByRole('option', { name: /Doing/ }));

    expect(
      screen.getByRole('button', { name: 'Status: Doing' })
    ).toBeInTheDocument();
    expect(updateIssue).toHaveBeenCalledWith('iss-1', { status_id: 'st-2' });
    finish({ ...issue, status_id: 'st-2', updated_at: '2026-09-18T00:00:00Z' });
    expect(
      await screen.findByRole('button', { name: 'Status: Doing' })
    ).toBeInTheDocument();
  });

  it('takes the change back and says so when the write fails', async () => {
    updateIssue.mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, 'Status: Todo');
    await user.click(await screen.findByRole('option', { name: /Doing/ }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeInTheDocument();
  });

  it('saves a priority change from its number key', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, 'Priority: High');
    await user.keyboard('4');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { priority: 'low' });
    });
  });

  it('clears the assignee to null rather than an empty string', async () => {
    getIssueByKey.mockResolvedValue({ ...issue, assignee_id: 'user-2' });
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, 'Assignee: Other');
    await user.click(screen.getByRole('option', { name: /No assignee/ }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { assignee_id: null });
    });
  });

  it('offers the estimates the team scale allows', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, /^Estimate:/);
    const values = within(screen.getByRole('listbox', { name: 'Estimate' }))
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(values).toHaveLength(8);
    expect(values[values.length - 1]).toContain('21');
  });

  it('leaves the estimate out when the team turned the scale off', async () => {
    listTeams.mockResolvedValue([{ ...team, estimate_scale: 'off' }]);
    renderPage();

    await screen.findByRole('button', { name: 'Status: Todo' });
    expect(
      screen.queryByRole('button', { name: /^Estimate:/ })
    ).not.toBeInTheDocument();
  });

  it('adds a label by sending the whole list, which is how the contract sets it', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, /^Labels:/);
    await user.click(await screen.findByRole('option', { name: /bug/ }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        label_ids: ['lb-1'],
      });
    });
  });

  it('offers a member no label creation, since that is a team admin action', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, /^Labels:/);
    await user.keyboard('infra');
    expect(
      screen.queryByRole('option', { name: /Create label/ })
    ).not.toBeInTheDocument();
  });

  it('saves a due date typed into the custom field', async () => {
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, /^Due date:/);
    await user.type(screen.getByLabelText('Custom date'), '2026-10-01{Enter}');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        due_date: '2026-10-01',
      });
    });
  });

  it('refuses a due date that falls before the start date', async () => {
    getIssueByKey.mockResolvedValue({ ...issue, start_date: '2026-10-05' });
    const user = userEvent.setup();
    renderPage();

    await openPicker(user, /^Due date:/);
    await user.type(screen.getByLabelText('Custom date'), '2026-10-01{Enter}');

    expect(
      await screen.findByText(/due date cannot fall before/i)
    ).toBeInTheDocument();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('offers a parent from the same team, never the issue itself', async () => {
    listIssues.mockResolvedValue({
      issues: [
        issue,
        { ...issue, id: 'iss-9', key: 'ENG-9', title: 'The epic' },
      ],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(listIssues).toHaveBeenCalled();
    });
    await openPicker(user, /^Parent:/);
    const rows = (await screen.findAllByRole('option')).map(
      (option) => option.textContent ?? ''
    );
    expect(rows.some((row) => row.includes('ENG-9'))).toBe(true);
    expect(rows.some((row) => row.includes('ENG-1'))).toBe(false);
  });
});

/** One relation row as the links read returns it. */
const relation = (
  type: LinkRead['type'],
  targetKey: string,
  targetTitle: string
): LinkRead => ({
  link_id: `ln-${targetKey}`,
  issue_id: 'iss-1',
  type,
  target_issue_id: `id-${targetKey}`,
  target_key: targetKey,
  target_title: targetTitle,
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
});

/** The rail section with the given name, once it has rendered. */
const railSection = async (name: string): Promise<HTMLElement> =>
  within(
    await screen.findByRole('complementary', { name: 'Properties' })
  ).findByRole('region', { name });

describe('the sub-issues', () => {
  it('counts done over total from the rollup, not from the rows', async () => {
    renderPage();

    const section = await railSection('Sub-issues');
    expect(within(section).getByText('2/4')).toBeInTheDocument();
  });

  it('lists the children it loaded, each linking to its issue', async () => {
    listChildren.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-2', key: 'ENG-2', title: 'A child' }],
      next_cursor: null,
    });
    renderPage();

    const child = await screen.findByText('A child');
    expect(child.closest('a')).toHaveAttribute('href', '/w/mine/issues/ENG-2');
  });

  it('folds the section away from its header', async () => {
    listChildren.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-2', key: 'ENG-2', title: 'A child' }],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('A child');
    const section = await railSection('Sub-issues');
    const toggle = within(section).getByRole('button', { name: /Sub-issues/ });
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('A child')).not.toBeVisible();
  });
});

describe('the parent', () => {
  it('shows the parent the issue is a sub-issue of, linked', async () => {
    const epic = { ...issue, id: 'iss-9', key: 'ENG-9', title: 'The epic' };
    getIssueByKey.mockResolvedValue({ ...issue, parent_id: 'iss-9' });
    listIssues.mockResolvedValue({ issues: [epic], next_cursor: null });
    renderPage();

    const link = await screen.findByRole('link', {
      name: 'Sub-issue of ENG-9 The epic',
    });
    expect(link).toHaveAttribute('href', '/w/mine/issues/ENG-9');
  });
});

describe('the relations', () => {
  it('groups relations by how they relate', async () => {
    listLinks.mockResolvedValue([
      relation('blocks', 'ENG-3', 'Blocked thing'),
      relation('blocked_by', 'ENG-6', 'Upstream'),
    ]);
    renderPage();

    const blocking = await screen.findByRole('list', { name: 'Blocking' });
    expect(within(blocking).getByText('ENG-3')).toBeInTheDocument();
    const blockedBy = screen.getByRole('list', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('Upstream')).toBeInTheDocument();
  });

  it('names the read only inverse the contract returns', async () => {
    listLinks.mockResolvedValue([
      relation('duplicated_by', 'ENG-4', 'The copy'),
    ]);
    renderPage();

    const group = await screen.findByRole('list', { name: 'Duplicates' });
    expect(within(group).getByText('ENG-4')).toBeInTheDocument();
  });

  it('removes a relation', async () => {
    listLinks.mockResolvedValue([relation('blocks', 'ENG-3', 'Blocked thing')]);
    deleteLink.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Remove relation to ENG-3' })
    );

    await waitFor(() => {
      expect(deleteLink).toHaveBeenCalledWith('ln-ENG-3');
    });
  });

  it('adds a relation from the section header through the picker', async () => {
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-5', key: 'ENG-5', title: 'Target' }],
      next_cursor: null,
    });
    createLink.mockResolvedValue(relation('blocks', 'ENG-5', 'Target'));
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Add relation' })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Add relation' });
    await user.selectOptions(
      within(dialog).getByLabelText('Relation'),
      'blocks'
    );
    await user.type(within(dialog).getByLabelText('Find an issue'), 'ENG-5');
    await user.click(
      await within(dialog).findByRole('button', { name: /ENG-5/ })
    );

    await waitFor(() => {
      expect(createLink).toHaveBeenCalledWith({
        type: 'blocks',
        target_issue_id: 'iss-5',
      });
    });
  });

  it('marks the issue as blocked by another from the issue menu', async () => {
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-5', key: 'ENG-5', title: 'Target' }],
      next_cursor: null,
    });
    createLink.mockResolvedValue(relation('blocked_by', 'ENG-5', 'Target'));
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Issue actions' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: /Mark as blocked by/ })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Mark as blocked by',
    });
    await user.type(within(dialog).getByLabelText('Find an issue'), 'ENG-5');
    await user.click(
      await within(dialog).findByRole('button', { name: /ENG-5/ })
    );

    await waitFor(() => {
      expect(createLink).toHaveBeenCalledWith({
        type: 'blocked_by',
        target_issue_id: 'iss-5',
      });
    });
  });
});

describe('the links and attachments', () => {
  it('opens the add link dialog from the issue menu', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Issue actions' })
    );
    await user.click(screen.getByRole('menuitem', { name: /Add link/ }));

    expect(
      await screen.findByRole('dialog', { name: 'Add link' })
    ).toBeInTheDocument();
  });
});

describe('the timeline', () => {
  it('says what changed and names the status from and to', async () => {
    listActivity.mockResolvedValue({
      activity: [
        {
          activity_id: 'ac-1',
          issue_id: 'iss-1',
          kind: 'field_changed',
          field: 'status_id',
          from: 'st-1',
          to: 'st-2',
          actor_kind: 'user',
          actor_id: 'user-2',
          created_at: '2026-09-17T01:00:00Z',
        },
      ],
      next_cursor: null,
    });
    renderPage();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(
        /Other\s*changed the status from\s*Todo\s*to\s*Doing/
      );
    });
  });

  it('names a non-human actor without looking for a member', async () => {
    listActivity.mockResolvedValue({
      activity: [
        {
          activity_id: 'ac-2',
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
    renderPage();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(/GitHub\s*created the issue/);
    });
  });

  it('loads older activity at the top on request', async () => {
    listActivity.mockResolvedValueOnce({
      activity: [
        {
          activity_id: 'ac-1',
          issue_id: 'iss-1',
          kind: 'created',
          field: null,
          from: null,
          to: null,
          actor_kind: 'user',
          actor_id: 'user-2',
          created_at: '2026-09-17T01:00:00Z',
        },
      ],
      next_cursor: 'cur-2',
    });
    listActivity.mockResolvedValue({
      activity: [
        {
          activity_id: 'ac-2',
          issue_id: 'iss-1',
          kind: 'link_added',
          field: null,
          from: null,
          to: null,
          actor_kind: 'user',
          actor_id: 'user-2',
          created_at: '2026-09-17T00:30:00Z',
        },
      ],
      next_cursor: null,
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Show older activity' })
    );

    const timeline = screen.getByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(/linked this to another issue/);
    });
    const text = timeline.textContent ?? '';
    expect(text.indexOf('linked this to')).toBeLessThan(
      text.indexOf('created the issue')
    );
  });
});

describe('the capability gate', () => {
  it('hides every control from a guest, since the server authorizes anyway', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestTeam } = team;
    listTeams.mockResolvedValue([guestTeam]);
    renderPage();

    await screen.findByText('Cache the token');
    expect(
      screen.queryByRole('button', { name: 'Edit title' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit description' })
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Status: Todo' })
    ).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Add relation' })
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Issue actions' }));
    expect(
      screen.queryByRole('menuitem', { name: /Add link/ })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: 'Copy link' })
    ).toBeInTheDocument();
  });
});
