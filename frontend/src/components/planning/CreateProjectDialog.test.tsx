/**
 * Project templates in the new project dialog: the team's default prefills
 * the form as it opens and says what it adds, the create names the template
 * and leaves out what it still holds for the server to fill, an edited field
 * is sent, going back to no template sends every field without it, and a
 * template issue the server left out raises a notice.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectCreate,
  ProjectRead,
  TeamRead,
  TemplateListRead,
  TemplateRead,
} from '../../types/Api';
import CreateProjectDialog from './CreateProjectDialog';

const createProject = vi.fn<(body: ProjectCreate) => Promise<ProjectRead>>();
const listTeamTemplates =
  vi.fn<(teamId: string, kind?: string) => Promise<TemplateListRead>>();

vi.mock('../../api/planning', () => ({
  createProject: (_w: string, body: ProjectCreate) => createProject(body),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: (
    _w: string,
    teamId: string,
    _signal?: AbortSignal,
    kind?: string
  ) => listTeamTemplates(teamId, kind),
}));

vi.mock('../../hooks/usePlanningTeamLists', () => ({
  usePlanningTeamLists: () => ({ statuses: [], labels: [], people: [] }),
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

const launch: TemplateRead = {
  id: 'tp-1',
  name: 'Feature launch',
  team_id: 't-1',
  scope: 'team',
  kind: 'project',
  project: {
    description: 'Ship the feature',
    member_ids: [],
    priority: 'high',
    milestones: [
      { key: 'm1', name: 'Alpha' },
      { key: 'm2', name: 'Beta' },
    ],
    issues: [{ key: 'i1', title: 'Write the plan' }],
  },
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
};

/** What the server answers for a created project. */
const created = (body: ProjectCreate): ProjectRead => ({
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  team_ids: ['t-1'],
  name: body.name,
  description: body.description ?? null,
  lead_id: null,
  start_date: null,
  target_date: null,
  status: body.status ?? 'planned',
  icon: null,
  color: null,
  health: null,
  priority: body.priority ?? 'none',
  member_ids: [],
  counts: { todo: 0, in_progress: 0, done: 0, cancelled: 0, total: 0 },
  created_by: 'user-1',
  created_at: '2026-10-23T00:00:00Z',
  updated_at: '2026-10-23T00:00:00Z',
});

const onCreated = vi.fn();

const showToast = vi.fn<(message: string, tone?: string) => number>();

vi.mock('../../lib/toast', () => ({
  showToast: (message: string, tone?: string) => showToast(message, tone),
}));

const renderDialog = () =>
  render(
    <CreateProjectDialog
      workspaceId="ws-1"
      teams={[team]}
      initialTeamIds={['t-1']}
      onClose={vi.fn()}
      onCreated={onCreated}
    />
  );

const summaryBox = () => screen.getByRole('textbox', { name: 'Summary' });

beforeEach(() => {
  createProject.mockReset();
  createProject.mockImplementation((body) => Promise.resolve(created(body)));
  listTeamTemplates.mockReset();
  listTeamTemplates.mockResolvedValue({
    templates: [launch],
    default_template_id: 'tp-1',
  });
  onCreated.mockReset();
  showToast.mockReset();
});

describe('project templates in the new project dialog', () => {
  it('opens with the default and sends what it does not hold', async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(summaryBox()).toHaveValue('Ship the feature');
    });
    expect(listTeamTemplates).toHaveBeenCalledWith('t-1', 'project');
    expect(
      screen.getByRole('button', { name: 'Template: Feature launch' })
    ).toBeInTheDocument();
    expect(
      screen.getByText('Adds 2 milestones and 1 issue')
    ).toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Search'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledTimes(1);
    });
    expect(createProject).toHaveBeenCalledWith({
      team_ids: ['t-1'],
      name: 'Search',
      health: null,
      template_id: 'tp-1',
      lead_id: null,
      start_date: null,
      target_date: null,
      status: 'planned',
      icon: null,
      color: null,
      member_ids: [],
    });
  });

  it('sends a field the person changed from the template', async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(summaryBox()).toHaveValue('Ship the feature');
    });
    await user.clear(summaryBox());
    await user.type(summaryBox(), 'Only search');
    await user.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Search'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledTimes(1);
    });
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        template_id: 'tp-1',
        description: 'Only search',
      })
    );
    expect(createProject.mock.calls[0]?.[0]).not.toHaveProperty('priority');
  });

  it('sends every field and no template once set to none', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      await screen.findByRole('button', { name: 'Template: Feature launch' })
    );
    await user.click(screen.getByRole('option', { name: /No template/ }));
    expect(summaryBox()).toHaveValue('');
    expect(
      screen.queryByText('Adds 2 milestones and 1 issue')
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Search'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledTimes(1);
    });
    const body = createProject.mock.calls[0]?.[0];
    expect(body).not.toHaveProperty('template_id');
    expect(body).toMatchObject({
      description: null,
      priority: 'none',
      status: 'planned',
    });
  });

  it('raises a notice for a template issue the server left out', async () => {
    const user = userEvent.setup();
    createProject.mockImplementation((body) =>
      Promise.resolve({
        ...created(body),
        skipped_template_issues: [
          {
            key: 'i1',
            title: 'Write the plan',
            reason: 'Sub-issues are one level deep',
          },
        ],
      })
    );
    renderDialog();

    await waitFor(() => {
      expect(summaryBox()).toHaveValue('Ship the feature');
    });
    await user.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Search'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(showToast).toHaveBeenCalledWith(
      'Left out template issue "Write the plan": Sub-issues are one level deep',
      'error'
    );
  });

  it('raises no notice when every template issue was added', async () => {
    const user = userEvent.setup();
    renderDialog();

    await waitFor(() => {
      expect(summaryBox()).toHaveValue('Ship the feature');
    });
    await user.type(
      screen.getByRole('textbox', { name: 'Project name' }),
      'Search'
    );
    await user.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(showToast).not.toHaveBeenCalled();
  });
});
