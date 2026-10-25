/**
 * The template editor on team settings: creating a template sends only what
 * was filled, moving one rewrites the positions that changed, deleting asks
 * first, inherited templates are listed read only with where they come from,
 * a caller who may not edit sees no controls, and sub-issues are added,
 * reordered and removed.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TemplateCreate,
  TemplateRead,
  TemplateUpdate,
} from '../../types/Api';
import TemplateEditor, { type TemplateEditorActions } from './TemplateEditor';

vi.mock(
  '../../hooks/useProjectStatuses',
  () => import('../../test/projectStatuses')
);

/** A saved template, each test filling what it needs. */
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

const create = vi.fn<(body: TemplateCreate) => Promise<unknown>>();
const update =
  vi.fn<(template: TemplateRead, body: TemplateUpdate) => Promise<unknown>>();
const remove = vi.fn<(template: TemplateRead) => Promise<unknown>>();
const actions: TemplateEditorActions = { create, update, remove };

const renderEditor = (templates: TemplateRead[], canEdit = true) =>
  render(
    <TemplateEditor
      templates={templates}
      scope="team"
      canEdit={canEdit}
      defaultTemplateId="tp-1"
      options={{ statuses: [], labels: [] }}
      actions={actions}
    />
  );

beforeEach(() => {
  for (const spy of [create, update, remove]) {
    spy.mockReset();
    spy.mockResolvedValue({});
  }
});

describe('the template editor', () => {
  it('creates a template with only the fields filled in', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(screen.getByRole('button', { name: 'New template' }));
    await user.type(screen.getByLabelText('Template name'), 'Bug report');
    await user.type(screen.getByLabelText('Issue title'), 'Bug: ');
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith({
        name: 'Bug report',
        title: 'Bug: ',
      });
    });
  });

  it('moves a template by rewriting the positions that changed', async () => {
    const user = userEvent.setup();
    const first = template({ id: 'tp-1', name: 'First', position: 0 });
    const second = template({ id: 'tp-2', name: 'Second', position: 1 });
    renderEditor([first, second]);

    await user.click(screen.getByRole('button', { name: 'Move Second up' }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(2);
    });
    expect(update).toHaveBeenCalledWith(second, { position: 0 });
    expect(update).toHaveBeenCalledWith(first, { position: 1 });
  });

  it('deletes only after the confirmation', async () => {
    const user = userEvent.setup();
    const saved = template({});
    renderEditor([saved]);

    await user.click(screen.getByRole('button', { name: 'Delete Bug report' }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(remove).toHaveBeenCalledWith(saved);
  });

  it('lists inherited templates read only with where they are kept', () => {
    renderEditor([template({ id: 'tp-9', name: 'Spike', scope: 'workspace' })]);

    expect(screen.getByText('Spike')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Spike' })
    ).not.toBeInTheDocument();
  });

  it('shows no controls to a caller who may not edit', () => {
    renderEditor([template({})], false);

    expect(
      screen.queryByRole('button', { name: 'New template' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Bug report' })
    ).not.toBeInTheDocument();
  });

  it('offers make recurring on own and inherited rows when asked', async () => {
    const user = userEvent.setup();
    const onMakeRecurring = vi.fn<(template: TemplateRead) => void>();
    render(
      <TemplateEditor
        templates={[
          template({}),
          template({
            id: 'tp-2',
            name: 'Workspace review',
            scope: 'workspace',
          }),
        ]}
        scope="team"
        canEdit
        options={{ statuses: [], labels: [] }}
        actions={actions}
        onMakeRecurring={onMakeRecurring}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Make Bug report recurring' })
    );
    await user.click(
      screen.getByRole('button', { name: 'Make Workspace review recurring' })
    );

    expect(onMakeRecurring.mock.calls.map(([row]) => row.id)).toEqual([
      'tp-1',
      'tp-2',
    ]);
  });

  it('shows no make recurring button without the callback', () => {
    renderEditor([template({})]);
    expect(
      screen.queryByRole('button', { name: 'Make Bug report recurring' })
    ).not.toBeInTheDocument();
  });
});

describe('template sub-issues', () => {
  it('creates a template with its sub-issues in order', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(screen.getByRole('button', { name: 'New template' }));
    await user.type(screen.getByLabelText('Template name'), 'Launch');
    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.type(
      screen.getByLabelText('Sub-issue 1 title'),
      'Write the notes'
    );
    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));
    await user.type(screen.getByLabelText('Sub-issue 2 title'), 'Announce it');
    await user.type(screen.getByLabelText('Sub-issue 2 description'), 'Post');
    await user.click(
      screen.getByRole('button', { name: 'Move sub-issue 2 up' })
    );
    await user.click(screen.getByRole('button', { name: 'Create template' }));

    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(create.mock.calls[0]?.[0]).toEqual({
      name: 'Launch',
      sub_issues: [
        {
          key: 's2',
          title: 'Announce it',
          body: 'Post',
          status_id: null,
          priority: null,
          assignee_id: null,
          label_ids: [],
          estimate: null,
        },
        {
          key: 's1',
          title: 'Write the notes',
          body: null,
          status_id: null,
          priority: null,
          assignee_id: null,
          label_ids: [],
          estimate: null,
        },
      ],
    });
  });

  it('holds the save while a sub-issue has no title', async () => {
    const user = userEvent.setup();
    renderEditor([]);

    await user.click(screen.getByRole('button', { name: 'New template' }));
    await user.type(screen.getByLabelText('Template name'), 'Launch');
    await user.click(screen.getByRole('button', { name: 'Add sub-issue' }));

    expect(
      screen.getByRole('button', { name: 'Create template' })
    ).toBeDisabled();
    await user.click(
      screen.getByRole('button', { name: 'Remove sub-issue 1' })
    );
    expect(
      screen.getByRole('button', { name: 'Create template' })
    ).toBeEnabled();
  });

  it('removes a saved sub-issue on edit', async () => {
    const user = userEvent.setup();
    renderEditor([
      template({
        name: 'Launch',
        sub_issues: [
          { key: 's1', title: 'Write the notes', label_ids: [] },
          { key: 's2', title: 'Announce it', label_ids: [] },
        ],
      }),
    ]);

    expect(screen.getByText('2 sub-issues')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Launch' }));
    await user.click(
      screen.getByRole('button', { name: 'Remove sub-issue 1' })
    );
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    expect(update.mock.calls[0]?.[1]).toMatchObject({
      sub_issues: [
        expect.objectContaining({ key: 's2', title: 'Announce it' }),
      ],
    });
  });
});
