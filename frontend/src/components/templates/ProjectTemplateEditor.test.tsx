/**
 * The project template editor: a template is created with its milestones and
 * issues referencing each other by key, dates that run backwards block the
 * save, a saved template's row says what it adds, and editing one sends its
 * whole blueprint.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectBlueprint,
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import ProjectTemplateEditor from './ProjectTemplateEditor';
import type { TemplateEditorActions } from './TemplateEditor';

vi.mock(
  '../../hooks/useProjectStatuses',
  () => import('../../test/projectStatuses')
);

const blueprint: ProjectBlueprint = {
  description: 'Ship the feature',
  lead_id: null,
  member_ids: [],
  status: null,
  priority: null,
  icon: null,
  color: null,
  start_offset_days: 0,
  target_offset_days: 30,
  milestones: [{ key: 'm1', name: 'Beta', target_offset_days: 14 }],
  issues: [
    { key: 'i1', title: 'Write the plan', milestone_key: 'm1' },
    { key: 'i2', title: 'Review the plan', parent_key: 'i1' },
  ],
};

/** A saved project template, each test filling what it needs. */
const template = (fields: Partial<TemplateRead>): TemplateRead => ({
  id: 'tp-1',
  name: 'Feature launch',
  team_id: null,
  scope: 'workspace',
  kind: 'project',
  project: blueprint,
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

const create = vi.fn<(body: TemplateCreate) => Promise<unknown>>();
const update =
  vi.fn<(template: TemplateRead, body: TemplateUpdate) => Promise<unknown>>();
const remove = vi.fn<(template: TemplateRead) => Promise<unknown>>();
const actions: TemplateEditorActions = { create, update, remove };

const renderEditor = (templates: TemplateRead[]) =>
  render(
    <ProjectTemplateEditor
      templates={templates}
      scope="workspace"
      canEdit
      defaultTemplateId="tp-1"
      options={{ statuses: [], labels: [] }}
      actions={actions}
    />
  );

/** A template issue as the form sends it, with nothing else filled. */
const issue = (key: string, title: string, extra: object = {}) => ({
  key,
  title,
  body: null,
  status_id: null,
  priority: null,
  assignee_id: null,
  label_ids: [],
  estimate: null,
  milestone_key: null,
  parent_key: null,
  ...extra,
});

beforeEach(() => {
  for (const spy of [create, update, remove]) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

describe('the project template editor', () => {
  it('creates a template with milestones and nested issues', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(
      screen.getByRole('button', { name: 'New project template' })
    );
    await user.type(screen.getByLabelText('Template name'), 'Launch');
    await user.click(screen.getByRole('button', { name: 'Add milestone' }));
    await user.type(screen.getByLabelText('Milestone 1 name'), 'Alpha');
    await user.type(
      screen.getByLabelText('Milestone 1 target, days after creation'),
      '7'
    );
    await user.click(screen.getByRole('button', { name: 'Add issue' }));
    await user.type(screen.getByLabelText('Issue 1 title'), 'Plan');
    await user.click(screen.getByRole('button', { name: 'Add issue' }));
    await user.type(screen.getByLabelText('Issue 2 title'), 'Build');
    await user.selectOptions(screen.getByLabelText('Issue 2 milestone'), 'm1');
    await user.selectOptions(screen.getByLabelText('Issue 2 parent'), 'i1');
    await user.click(
      screen.getByRole('button', { name: 'Create project template' })
    );

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(create).toHaveBeenCalledWith({
      kind: 'project',
      name: 'Launch',
      project: {
        description: null,
        lead_id: null,
        member_ids: [],
        status: null,
        priority: null,
        icon: null,
        color: null,
        start_offset_days: null,
        target_offset_days: null,
        milestones: [
          {
            key: 'm1',
            name: 'Alpha',
            description: null,
            target_offset_days: 7,
          },
        ],
        issues: [
          issue('i1', 'Plan'),
          issue('i2', 'Build', { milestone_key: 'm1', parent_key: 'i1' }),
        ],
      },
    });
  });

  it('blocks a target that comes before the start', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(
      screen.getByRole('button', { name: 'New project template' })
    );
    await user.type(screen.getByLabelText('Template name'), 'Launch');
    await user.type(screen.getByLabelText('Start, days after creation'), '10');
    await user.type(screen.getByLabelText('Target, days after creation'), '5');

    expect(
      screen.getByText('The target cannot come before the start.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Create project template' })
    ).toBeDisabled();
  });

  it('says what a saved template adds and marks the default', () => {
    renderEditor([template({})]);

    expect(screen.getByText('Feature launch')).toBeInTheDocument();
    expect(
      screen.getByText('Adds 1 milestone and 2 issues')
    ).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('sends the whole blueprint when a template is edited', async () => {
    const user = userEvent.setup();
    const saved = template({});
    renderEditor([saved]);

    await user.click(
      screen.getByRole('button', { name: 'Edit Feature launch' })
    );
    await user.click(screen.getByRole('button', { name: 'Remove issue 1' }));
    await user.click(
      screen.getByRole('button', { name: 'Save project template' })
    );

    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(update).toHaveBeenCalledWith(saved, {
      name: 'Feature launch',
      project: {
        description: 'Ship the feature',
        lead_id: null,
        member_ids: [],
        status: null,
        priority: null,
        icon: null,
        color: null,
        start_offset_days: 0,
        target_offset_days: 30,
        milestones: [
          {
            key: 'm1',
            name: 'Beta',
            description: null,
            target_offset_days: 14,
          },
        ],
        issues: [issue('i2', 'Review the plan')],
      },
    });
  });
});
