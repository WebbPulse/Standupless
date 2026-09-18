/**
 * The saved views panel. Covers that creating a view sends the filter the page
 * is showing and never a derived scope or owner, that applying one hands the
 * stored filter back rather than reading issues here, and that renaming and
 * deleting reach the single view route.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedViewRead } from '../../types/Api';
import SavedViewsPanel from './SavedViewsPanel';

const listViews = vi.fn<(query: unknown) => Promise<SavedViewRead[]>>();
const createView = vi.fn<(body: unknown) => Promise<SavedViewRead>>();
const updateView = vi.fn<(id: string, body: unknown) => Promise<SavedViewRead>>();
const deleteView = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    listViews: (_w: string, query: unknown) => listViews(query),
    createView: (_w: string, body: unknown) => createView(body),
    updateView: (_w: string, id: string, body: unknown) =>
      updateView(id, body),
    deleteView: (_w: string, id: string) => deleteView(id),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** One saved view in the shape the contract answers with. */
const view = (over: Partial<SavedViewRead> = {}): SavedViewRead => ({
  view_id: 'v-1',
  workspace_id: 'ws-1',
  name: 'Mine, urgent',
  kind: 'board',
  scope: 'personal',
  project_id: null,
  filter: { priority: 'urgent' },
  sort: 'updated_desc',
  group_by: null,
  owner_id: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  ...over,
});

const onApply = vi.fn();

const renderPanel = (
  over: Partial<React.ComponentProps<typeof SavedViewsPanel>> = {}
) =>
  render(
    <SavedViewsPanel
      workspaceId="ws-1"
      projectId="proj-1"
      currentFilter={{ priority: 'high' }}
      currentKind="board"
      onApply={onApply}
      {...over}
    />
  );

beforeEach(() => {
  listViews.mockReset();
  createView.mockReset();
  updateView.mockReset();
  deleteView.mockReset();
  onApply.mockReset();
  listViews.mockResolvedValue([view()]);
  createView.mockResolvedValue(view({ view_id: 'v-2' }));
  updateView.mockResolvedValue(view({ name: 'Renamed' }));
  deleteView.mockResolvedValue(undefined);
});

describe('saved views panel', () => {
  it('lists the saved views', async () => {
    renderPanel();

    expect(await screen.findByText('Mine, urgent')).toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    listViews.mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText('No saved views yet.')).toBeInTheDocument();
  });

  it('reads the caller own views by default', async () => {
    renderPanel();

    await waitFor(() => {
      expect(listViews).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'mine' })
      );
    });
  });

  it('re-reads under a different scope when one is chosen', async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Mine, urgent');
    await user.selectOptions(screen.getByLabelText('Show'), 'project');

    await waitFor(() => {
      expect(listViews).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'project' })
      );
    });
  });

  it('saves the filter the page is showing, with no derived fields', async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Mine, urgent');
    await user.type(screen.getByLabelText('Save this view'), 'Urgent work');
    await user.click(screen.getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalledWith({
        name: 'Urgent work',
        kind: 'board',
        filter: { priority: 'high' },
      });
    });
    const [body] = createView.mock.calls[0] ?? [];
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('owner_id');
  });

  it('shares a view with the project when asked to', async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByText('Mine, urgent');
    await user.type(screen.getByLabelText('Save this view'), 'Team board');
    await user.click(screen.getByLabelText('Share with the project'));
    await user.click(screen.getByRole('button', { name: 'Save view' }));

    await waitFor(() => {
      expect(createView).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 'proj-1' })
      );
    });
  });

  it('hands the stored filter back rather than reading issues here', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Mine, urgent' }));

    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { priority: 'urgent' } })
    );
  });

  it('renames a view through the single view route', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Rename Mine, urgent' })
    );
    const box = screen.getByLabelText('New name');
    await user.clear(box);
    await user.type(box, 'Now urgent');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateView).toHaveBeenCalledWith('v-1', { name: 'Now urgent' });
    });
  });

  it('deletes a view', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(
      await screen.findByRole('button', { name: 'Delete Mine, urgent' })
    );

    await waitFor(() => {
      expect(deleteView).toHaveBeenCalledWith('v-1');
    });
  });

  it('surfaces a failed read', async () => {
    listViews.mockRejectedValue(new Error('boom'));
    renderPanel();

    expect(
      await screen.findByText('Could not load the saved views.')
    ).toBeInTheDocument();
  });
});
