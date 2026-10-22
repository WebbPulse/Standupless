/**
 * The new issue dialog's planning and content fields. Covers the milestone
 * chip appearing once a project is chosen and scoped to it, the parent chip
 * searching the team and prefilled from an issue, sub-issue rows filed under
 * the new issue in the same save, a pasted file held in the description and
 * uploaded once the issue exists, and the expand toggle.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import type {
  AttachmentRead,
  IssueCreate,
  IssueListRead,
  IssueRead,
  IssueUpdate,
  MilestoneRead,
  ProjectRead,
  RollupCounts,
  StatusRead,
  TeamRead,
} from '../../types/Api';
import CreateIssueDialog, { type CreateIssuePreset } from './CreateIssueDialog';

const createIssue = vi.fn<(body: IssueCreate) => Promise<IssueRead>>();
const updateIssue =
  vi.fn<(issueId: string, body: IssueUpdate) => Promise<IssueRead>>();
const listIssues = vi.fn<(query: unknown) => Promise<IssueListRead>>();
const listMilestones = vi.fn<(projectId: string) => Promise<MilestoneRead[]>>();
const uploadAttachment =
  vi.fn<(issueId: string, file: File) => Promise<AttachmentRead>>();

vi.mock('../../api/issues', () => ({
  createIssue: (_w: string, body: IssueCreate) => createIssue(body),
  updateIssue: (_w: string, issueId: string, body: IssueUpdate) =>
    updateIssue(issueId, body),
  createLink: () => Promise.resolve({}),
  listIssues: (_w: string, query: unknown) => listIssues(query),
}));

vi.mock('../../api/discussion', () => ({
  uploadAttachment: (_w: string, issueId: string, file: File) =>
    uploadAttachment(issueId, file),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () => Promise.resolve([team]),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve([]),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/views', () => ({
  similarIssues: () => Promise.resolve([]),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: () =>
    Promise.resolve({ templates: [], default_template_id: null }),
}));

vi.mock('../../api/planning', () => ({
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
  listProjects: () =>
    Promise.resolve({ projects: [project], next_cursor: null }),
  listMilestones: (_w: string, projectId: string) => listMilestones(projectId),
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

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
];

const counts: RollupCounts = {
  todo: 0,
  in_progress: 0,
  done: 0,
  cancelled: 0,
  total: 0,
};

const project: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  team_ids: ['t-1'],
  lead_id: null,
  start_date: null,
  name: 'Public beta',
  description: null,
  target_date: null,
  status: 'planned',
  icon: null,
  color: null,
  health: null,
  priority: 'none',
  member_ids: [],
  counts,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

const milestone: MilestoneRead = {
  milestone_id: 'ms-1',
  workspace_id: 'ws-1',
  project_id: 'prj-1',
  name: 'Alpha',
  description: null,
  target_date: null,
  sort_order: 'V',
  counts,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** An issue as the server answers it. */
const issueOf = (key: string, body: IssueCreate): IssueRead => ({
  id: `id-${key}`,
  workspace_id: 'ws-1',
  team_id: body.team_id,
  key,
  number: 1,
  title: body.title,
  body: body.body ?? null,
  status_id: 'st-1',
  priority: 'none',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: body.parent_id ?? null,
  cycle_id: body.cycle_id ?? null,
  project_id: body.project_id ?? null,
  project_milestone_id: body.project_milestone_id ?? null,
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

const renderDialog = (preset?: CreateIssuePreset) =>
  render(
    <WorkspaceContext.Provider value={workspace}>
      <CreateIssueDialog
        workspaceId="ws-1"
        teamId="t-1"
        teamName="Engine"
        estimateScale="off"
        statuses={statuses}
        labels={[]}
        people={[]}
        onCreated={onCreated}
        onClose={vi.fn()}
        {...(preset === undefined ? {} : { preset })}
      />
    </WorkspaceContext.Provider>
  );

let counter = 0;

beforeEach(() => {
  counter = 0;
  for (const spy of [
    createIssue,
    updateIssue,
    listIssues,
    listMilestones,
    uploadAttachment,
    onCreated,
  ]) {
    spy.mockReset();
  }
  createIssue.mockImplementation((body) => {
    counter += 1;
    return Promise.resolve(issueOf(`ENG-${String(counter)}`, body));
  });
  updateIssue.mockImplementation((issueId, body) =>
    Promise.resolve({
      ...issueOf('ENG-1', { team_id: 't-1', title: 'Saved' }),
      id: issueId,
      body: body.body ?? null,
    })
  );
  listMilestones.mockResolvedValue([milestone]);
  listIssues.mockResolvedValue({
    issues: [issueOf('ENG-9', { team_id: 't-1', title: 'Launch the beta' })],
    next_cursor: null,
  });
});

describe('milestone', () => {
  it('appears once a project is chosen and files under it', async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.queryByRole('button', { name: /^Milestone:/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Project: Project' }));
    await user.click(
      await screen.findByRole('option', { name: /Public beta/ })
    );
    await user.click(
      await screen.findByRole('button', { name: 'Milestone: Milestone' })
    );
    await user.click(await screen.findByRole('option', { name: /Alpha/ }));
    expect(listMilestones).toHaveBeenCalledWith('prj-1');

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Ship');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Ship',
        project_id: 'prj-1',
        project_milestone_id: 'ms-1',
      });
    });
  });
});

describe('parent', () => {
  it('searches the team top level issues and files under the pick', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Parent: Parent' }));
    await user.click(
      await screen.findByRole('option', { name: /Launch the beta/ })
    );
    expect(listIssues).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 't-1', parent_id: 'none' })
    );
    expect(screen.getByText('New sub-issue of ENG-9')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add sub-issues/ })).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Child');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Child',
        parent_id: 'id-ENG-9',
      });
    });
  });

  it('is prefilled when the dialog opens from an issue', () => {
    renderDialog({ parentId: 'id-ENG-7', parentKey: 'ENG-7' });

    expect(
      screen.getByRole('button', { name: 'Parent: ENG-7' })
    ).toBeInTheDocument();
    expect(screen.getByText('New sub-issue of ENG-7')).toBeInTheDocument();
  });
});

describe('sub-issues', () => {
  it('files each row under the new issue in the same save', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Epic');
    await user.click(screen.getByRole('button', { name: /Add sub-issues/ }));
    const first = screen.getByRole('textbox', { name: 'Sub-issue 1 title' });
    expect(first).toHaveFocus();
    await user.type(first, 'First step{Enter}');
    const second = screen.getByRole('textbox', { name: 'Sub-issue 2 title' });
    expect(second).toHaveFocus();
    await user.type(second, 'Second step');
    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled();
    });
    expect(createIssue.mock.calls.map(([body]) => body)).toEqual([
      { team_id: 't-1', title: 'Epic' },
      { team_id: 't-1', title: 'First step', parent_id: 'id-ENG-1' },
      { team_id: 't-1', title: 'Second step', parent_id: 'id-ENG-1' },
    ]);
  });

  it('drops an empty row on Backspace', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /Add sub-issues/ }));
    await user.keyboard('{Backspace}');

    expect(
      screen.queryByRole('textbox', { name: 'Sub-issue 1 title' })
    ).toBeNull();
  });
});

describe('attachments', () => {
  it('holds a pasted file and uploads it into the description', async () => {
    const user = userEvent.setup();
    uploadAttachment.mockResolvedValue({
      attachment_id: 'att-1',
      issue_id: 'id-ENG-1',
      workspace_id: 'ws-1',
      team_id: 't-1',
      kind: 'file',
      title: 'shot.png',
      content_type: 'image/png',
      uploaded_by: 'user-1',
      created_at: '2026-09-18T00:00:00Z',
    });
    renderDialog();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Bug');
    const description = screen.getByRole('textbox', { name: 'Description' });
    await user.type(description, 'Look');
    const file = new File(['png'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(description, {
      clipboardData: { files: [file], types: ['Files'] },
    });

    expect(description).toHaveValue(
      expect.stringMatching(/^Look\n!\[shot\.png\]\(pending-upload:[\w-]+\)\n$/)
    );
    expect(screen.getByRole('list', { name: 'Attachments' })).toHaveTextContent(
      'shot.png'
    );

    await user.click(screen.getByRole('button', { name: /Create issue/ }));

    await waitFor(() => {
      expect(updateIssue).toHaveBeenCalled();
    });
    expect(createIssue).toHaveBeenCalledWith({
      team_id: 't-1',
      title: 'Bug',
      body: 'Look',
    });
    expect(uploadAttachment).toHaveBeenCalledWith('id-ENG-1', file);
    expect(updateIssue).toHaveBeenCalledWith('id-ENG-1', {
      body: 'Look\n![shot.png](/api/workspaces/ws-1/attachments/att-1/content?issue_id=id-ENG-1)',
    });
  });

  it('takes the placeholder out when the file is removed', () => {
    renderDialog();

    const description = screen.getByRole('textbox', { name: 'Description' });
    const file = new File(['pdf'], 'spec.pdf', { type: 'application/pdf' });
    fireEvent.paste(description, {
      clipboardData: { files: [file], types: ['Files'] },
    });
    expect(description).toHaveValue(
      expect.stringMatching(/^\[spec\.pdf\]\(pending-upload:/)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove spec.pdf' }));

    expect(description).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
  });
});

describe('expand', () => {
  it('toggles the dialog to its full size', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: 'Expand' }));

    expect(screen.getByRole('button', { name: 'Collapse' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('dialog')).toHaveClass('max-w-5xl');
  });
});
