/**
 * The template editor on team settings: creating a template sends only what
 * was filled, moving one rewrites the positions that changed, deleting asks
 * first, inherited templates are listed read only with where they come from,
 * and a caller who may not edit sees no controls.
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
});
