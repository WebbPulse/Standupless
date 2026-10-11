/**
 * Templates in the new issue dialog: the team's default prefilling the draft
 * as it opens, a preset winning over the template, a template named by the
 * caller in place of the default, picking one from the header chip and going
 * back to none, a field the person clears staying cleared, and a prefilled
 * draft nobody touched closing without the discard guard.
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
  TemplateListRead,
  TemplateRead,
} from '../../types/Api';
import CreateIssueDialog, { type CreateIssuePreset } from './CreateIssueDialog';

const createIssue = vi.fn<(body: IssueCreate) => Promise<IssueRead>>();
const listTeamTemplates =
  vi.fn<(teamId: string) => Promise<TemplateListRead>>();

vi.mock('../../api/issues', () => ({
  createIssue: (_w: string, body: IssueCreate) => createIssue(body),
  createLink: () => Promise.resolve({}),
  listIssues: () => Promise.resolve({ issues: [], next_cursor: null }),
}));

vi.mock('../../api/teams', () => ({
  listTeams: () =>
    Promise.resolve([
      makeTeam('t-1', 'Engine', 'ENG'),
      makeTeam('t-2', 'Design', 'DES'),
    ]),
  listStatuses: () => Promise.resolve(statuses),
  listLabels: () => Promise.resolve(labels),
  listTeamMembers: () => Promise.resolve([]),
  createLabel: vi.fn(),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: (_w: string, teamId: string) => listTeamTemplates(teamId),
}));

vi.mock('../../api/views', () => ({
  similarIssues: () => Promise.resolve([]),
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
function makeTeam(id: string, name: string, prefix: string): TeamRead {
  return {
    id,
    workspace_id: 'ws-1',
    name,
    key_prefix: prefix,
    description: null,
    estimate_scale: 'off',
    created_at: '2026-09-17T00:00:00Z',
    updated_at: '2026-09-17T00:00:00Z',
    role: 'member',
  };
}

const statuses: StatusRead[] = [
  { id: 'st-1', name: 'Backlog', category: 'backlog', position: 0 },
  { id: 'st-2', name: 'Todo', category: 'unstarted', position: 1 },
];

const labels: LabelRead[] = [{ id: 'lb-1', name: 'bug', color: '#ef4444' }];

/** A template with nothing filled, for each test to fill what it needs. */
const template = (fields: Partial<TemplateRead>): TemplateRead => ({
  id: 'tp-1',
  name: 'Bug report',
  team_id: 't-1',
  scope: 'team',
  title: null,
  body: null,
  status_id: null,
  priority: null,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  project_id: null,
  project_milestone_id: null,
  cycle_id: null,
  position: 0,
  created_by: 'user-1',
  created_at: '2026-10-10T00:00:00Z',
  updated_at: '2026-10-10T00:00:00Z',
  ...fields,
});

const bug = template({
  title: 'Bug: ',
  body: 'Steps to reproduce',
  status_id: 'st-2',
  priority: 'high',
  label_ids: ['lb-1', 'lb-gone'],
});

const spike = template({
  id: 'tp-2',
  name: 'Spike',
  title: 'Spike: ',
  scope: 'workspace',
  position: 1,
});

/** What the server answers for a created issue. */
const created = (body: IssueCreate): IssueRead => ({
  id: 'id-ENG-1',
  workspace_id: 'ws-1',
  team_id: body.team_id,
  key: 'ENG-1',
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

const renderDialog = (preset?: CreateIssuePreset) =>
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
        {...(preset === undefined ? {} : { preset })}
      />
    </WorkspaceContext.Provider>
  );

/** The title box, once a template has had the chance to fill it. */
const titleBox = () => screen.getByRole('textbox', { name: 'Title' });

beforeEach(() => {
  for (const spy of [createIssue, listTeamTemplates, onCreated, onClose]) {
    spy.mockReset();
  }
  createIssue.mockImplementation((body) => Promise.resolve(created(body)));
  listTeamTemplates.mockResolvedValue({
    templates: [bug, spike],
    default_template_id: null,
  });
});

describe('the default template', () => {
  it('prefills the draft and sends what the fields hold, never the template', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [bug, spike],
      default_template_id: 'tp-1',
    });
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(titleBox()).toHaveValue('Bug: ');
    });
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Steps to reproduce'
    );
    expect(
      screen.getByRole('button', { name: 'Template: Bug report' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Status: Todo' })
    ).toBeInTheDocument();

    await user.type(titleBox(), 'login loops');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith({
        team_id: 't-1',
        title: 'Bug: login loops',
        body: 'Steps to reproduce',
        status_id: 'st-2',
        priority: 'high',
        label_ids: ['lb-1'],
      });
    });
  });

  it('leaves a preset property alone', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [bug],
      default_template_id: 'tp-1',
    });
    const user = userEvent.setup();
    renderDialog({ statusId: 'st-1' });

    await waitFor(() => {
      expect(titleBox()).toHaveValue('Bug: ');
    });
    expect(
      screen.getByRole('button', { name: 'Status: Backlog' })
    ).toBeInTheDocument();

    await user.type(titleBox(), 'x');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalledWith(
        expect.objectContaining({ status_id: 'st-1', priority: 'high' })
      );
    });
  });

  it('gives way to a template the caller named', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [bug, spike],
      default_template_id: 'tp-1',
    });
    renderDialog({ templateId: 'tp-2' });

    await waitFor(() => {
      expect(titleBox()).toHaveValue('Spike: ');
    });
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      ''
    );
  });

  it('keeps a cleared field cleared', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [bug],
      default_template_id: 'tp-1',
    });
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(titleBox()).toHaveValue('Bug: ');
    });
    await user.clear(screen.getByRole('textbox', { name: 'Description' }));
    await user.type(titleBox(), 'x');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(createIssue).toHaveBeenCalled();
    });
    const sent = createIssue.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty('body');
    expect(sent).not.toHaveProperty('template_id');
  });

  it('closes an untouched prefilled draft without asking', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [bug],
      default_template_id: 'tp-1',
    });
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(titleBox()).toHaveValue('Bug: ');
    });
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
  });
});

describe('the template picker', () => {
  it('starts the draft from the picked template and back to none', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      await screen.findByRole('button', { name: 'Template: none' })
    );
    expect(screen.getByRole('option', { name: /Spike/ })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /Bug report/ }));

    expect(titleBox()).toHaveValue('Bug: ');
    expect(titleBox()).toHaveFocus();
    expect(
      screen.getByRole('button', { name: 'Status: Todo' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Template: Bug report' })
    );
    await user.click(screen.getByRole('option', { name: /No template/ }));

    expect(titleBox()).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      ''
    );
    expect(
      screen.getByRole('button', { name: 'Status: Backlog' })
    ).toBeInTheDocument();
  });

  it('keeps a title the person typed when a template is picked', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(titleBox(), 'My own words');
    await user.click(
      await screen.findByRole('button', { name: 'Template: none' })
    );
    await user.click(screen.getByRole('option', { name: /Bug report/ }));

    expect(titleBox()).toHaveValue('My own words');
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue(
      'Steps to reproduce'
    );
  });

  it('is absent when the team offers no templates', async () => {
    listTeamTemplates.mockResolvedValue({
      templates: [],
      default_template_id: null,
    });
    renderDialog();

    await waitFor(() => {
      expect(listTeamTemplates).toHaveBeenCalledWith('t-1');
    });
    expect(
      screen.queryByRole('button', { name: /^Template/ })
    ).not.toBeInTheDocument();
  });
});
