/**
 * The issue detail page. Covers resolving the key through the by-key read, the
 * inline edits each field sends as its own PATCH, the sub-issue progress bar
 * coming from the rolled up counts rather than the rows, the links section and
 * the activity feed, and the capability gate that hides every control.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  ActivityListRead,
  IssueListRead,
  IssueRead,
  LabelRead,
  LinkRead,
  ProjectMemberRead,
  ProjectRead,
  StatusRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import IssueDetail from './IssueDetail';

const getIssueByKey = vi.fn<() => Promise<IssueRead>>();
const updateIssue = vi.fn<(id: string, body: unknown) => Promise<IssueRead>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listChildren = vi.fn<() => Promise<IssueListRead>>();
const listLinks = vi.fn<() => Promise<LinkRead[]>>();
const createLink = vi.fn<(body: unknown) => Promise<LinkRead>>();
const deleteLink = vi.fn<(linkId: string) => Promise<void>>();
const listActivity = vi.fn<() => Promise<ActivityListRead>>();

const listProjects = vi.fn<() => Promise<ProjectRead[]>>();
const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const listProjectMembers = vi.fn<() => Promise<ProjectMemberRead[]>>();

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

vi.mock('../../api/projects', () => ({
  listProjects: () => listProjects(),
  listStatuses: () => listStatuses(),
  listLabels: () => listLabels(),
  listProjectMembers: () => listProjectMembers(),
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

/** The project the issue belongs to, on the fibonacci scale so estimates show. */
const project: ProjectRead = {
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

/** One project member, so the assignee select has a person on it. */
const member: ProjectMemberRead = {
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
  project_id: 'proj-1',
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
    listProjects,
    listStatuses,
    listLabels,
    listProjectMembers,
  ]) {
    spy.mockReset();
  }
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('member'));
  getIssueByKey.mockResolvedValue(issue);
  updateIssue.mockResolvedValue(issue);
  listIssues.mockResolvedValue({ issues: [], next_cursor: null });
  listChildren.mockResolvedValue({ issues: [], next_cursor: null });
  listLinks.mockResolvedValue([]);
  listActivity.mockResolvedValue({ activity: [], next_cursor: null });
  listProjects.mockResolvedValue([project]);
  listStatuses.mockResolvedValue(statuses);
  listLabels.mockResolvedValue([label]);
  listProjectMembers.mockResolvedValue([member]);
});

describe('resolving the issue', () => {
  it('reads the issue by the key in the route', async () => {
    renderPage();

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(getIssueByKey).toHaveBeenCalled();
  });

  it('links back to the project the issue belongs to', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'Engine' })).toHaveAttribute(
      'href',
      '/w/mine/p/ENG'
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

  it('previews the description as written, since no renderer is a dependency', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Edit description' })
    );

    const preview = await screen.findByText('Some **markdown** body', {
      selector: 'pre',
    });
    expect(preview).toBeInTheDocument();
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
  it('saves a status change on its own', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: 'Doing' });
    await user.selectOptions(screen.getByLabelText('Status'), 'st-2');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { status_id: 'st-2' });
    });
  });

  it('saves a priority change', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: 'Low' });
    await user.selectOptions(screen.getByLabelText('Priority'), 'low');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { priority: 'low' });
    });
  });

  it('clears the assignee to null rather than an empty string', async () => {
    getIssueByKey.mockResolvedValue({ ...issue, assignee_id: 'user-2' });
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: 'Other' });
    await user.selectOptions(screen.getByLabelText('Assignee'), '');

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', { assignee_id: null });
    });
  });

  it('offers the estimates the project scale allows', async () => {
    renderPage();

    await screen.findByRole('option', { name: '21' });
    const select = screen.getByLabelText('Estimate');
    const values = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['', '1', '2', '3', '5', '8', '13', '21']);
  });

  it('leaves the estimate out when the project turned the scale off', async () => {
    listProjects.mockResolvedValue([{ ...project, estimate_scale: 'off' }]);
    renderPage();

    await screen.findByLabelText('Status');
    expect(screen.queryByLabelText('Estimate')).not.toBeInTheDocument();
  });

  it('adds a label by sending the whole list, which is how the contract sets it', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByLabelText('bug'));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalledWith('iss-1', {
        label_ids: ['lb-1'],
      });
    });
  });

  it('saves a due date', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Due date'), '2026-10-01');

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

    await user.type(await screen.findByLabelText('Due date'), '2026-10-01');

    expect(
      await screen.findByText(/due date cannot fall before/i)
    ).toBeInTheDocument();
    expect(updateIssue).not.toHaveBeenCalled();
  });

  it('offers a parent from the same project, never the issue itself', async () => {
    listIssues.mockResolvedValue({
      issues: [
        issue,
        { ...issue, id: 'iss-9', key: 'ENG-9', title: 'The epic' },
      ],
      next_cursor: null,
    });
    renderPage();

    await screen.findByRole('option', { name: /ENG-9/ });
    const select = screen.getByLabelText('Parent');
    const values = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(['', 'iss-9']);
  });
});

describe('the sub-issues', () => {
  it('reads the progress bar from the rollup, not from the rows', async () => {
    renderPage();

    const bar = await screen.findByRole('progressbar', {
      name: 'Sub-issue progress',
    });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('2 of 4 done')).toBeInTheDocument();
  });

  it('lists the children it loaded', async () => {
    listChildren.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-2', key: 'ENG-2', title: 'A child' }],
      next_cursor: null,
    });
    renderPage();

    expect(await screen.findByText('A child')).toBeInTheDocument();
  });
});

describe('the links', () => {
  it('lists a link with its type and target', async () => {
    listLinks.mockResolvedValue([
      {
        link_id: 'ln-1',
        issue_id: 'iss-1',
        type: 'blocks',
        target_issue_id: 'iss-3',
        target_key: 'ENG-3',
        target_title: 'Blocked thing',
        created_by: 'user-1',
        created_at: '2026-09-17T00:00:00Z',
      },
    ]);
    renderPage();

    expect(await screen.findByText('Blocks')).toBeInTheDocument();
    expect(await screen.findByText('ENG-3')).toBeInTheDocument();
  });

  it('names the read only inverse the contract returns', async () => {
    listLinks.mockResolvedValue([
      {
        link_id: 'ln-2',
        issue_id: 'iss-1',
        type: 'duplicated_by',
        target_issue_id: 'iss-4',
        target_key: 'ENG-4',
        target_title: 'The original',
        created_by: 'user-1',
        created_at: '2026-09-17T00:00:00Z',
      },
    ]);
    renderPage();

    expect(await screen.findByText('Duplicated by')).toBeInTheDocument();
  });

  it('removes a link', async () => {
    listLinks.mockResolvedValue([
      {
        link_id: 'ln-1',
        issue_id: 'iss-1',
        type: 'blocks',
        target_issue_id: 'iss-3',
        target_key: 'ENG-3',
        target_title: 'Blocked thing',
        created_by: 'user-1',
        created_at: '2026-09-17T00:00:00Z',
      },
    ]);
    deleteLink.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Remove link to ENG-3' })
    );

    await waitFor(() => {
      expect(deleteLink).toHaveBeenCalledWith('ln-1');
    });
  });

  it('finds a target by key search and adds the link', async () => {
    listIssues.mockResolvedValue({
      issues: [{ ...issue, id: 'iss-5', key: 'ENG-5', title: 'Target' }],
      next_cursor: null,
    });
    createLink.mockResolvedValue({
      link_id: 'ln-3',
      issue_id: 'iss-1',
      type: 'blocks',
      target_issue_id: 'iss-5',
      target_key: 'ENG-5',
      target_title: 'Target',
      created_by: 'user-1',
      created_at: '2026-09-17T00:00:00Z',
    });
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Find an issue'), 'ENG-5');
    await user.click(
      await screen.findByRole('button', { name: /ENG-5 Target/ })
    );

    await waitFor(() => {
      expect(createLink).toHaveBeenCalledWith({
        type: 'blocks',
        target_issue_id: 'iss-5',
      });
    });
  });
});

describe('the activity feed', () => {
  it('says what changed, leaving the ids to the fields above', async () => {
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

    const entry = await screen.findByText('changed the status');
    expect(entry).toBeInTheDocument();
    const row = entry.closest('li');
    if (row === null) throw new Error('the entry rendered outside a list item');
    expect(within(row).getByText('Other')).toBeInTheDocument();
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

    expect(await screen.findByText('GitHub')).toBeInTheDocument();
    expect(screen.getByText('created this issue')).toBeInTheDocument();
  });

  it('loads the next page of activity on request', async () => {
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

    const feed = await screen.findByRole('button', { name: 'Load more' });
    await user.click(feed);

    expect(await screen.findByText('added a link')).toBeInTheDocument();
  });
});

describe('the capability gate', () => {
  it('hides every control from a guest, since the server authorizes anyway', async () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    const { role: _role, ...guestProject } = project;
    listProjects.mockResolvedValue([guestProject]);
    renderPage();

    await screen.findByText('Cache the token');
    expect(
      screen.queryByRole('button', { name: 'Edit title' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit description' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText('Status')).toBeDisabled();
    expect(screen.queryByLabelText('Find an issue')).not.toBeInTheDocument();
  });
});
