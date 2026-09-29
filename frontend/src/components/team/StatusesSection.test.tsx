/**
 * The statuses section's color and icon picker. Covers that the glyph opens a
 * panel reachable from the keyboard, that resting on a swatch previews it
 * without saving, that choosing saves at once, that the default clears the
 * field, and that a new status can be added with a look of its own.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusCreate, StatusRead, StatusUpdate } from '../../types/Api';
import StatusesSection from './StatusesSection';

const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const updateStatus =
  vi.fn<(statusId: string, body: StatusUpdate) => Promise<StatusRead>>();
const createStatus = vi.fn<(body: StatusCreate) => Promise<StatusRead>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listStatuses: () => listStatuses(),
    updateStatus: (_w: string, _t: string, id: string, body: StatusUpdate) =>
      updateStatus(id, body),
    createStatus: (_w: string, _t: string, body: StatusCreate) =>
      createStatus(body),
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

const rows: StatusRead[] = [
  { id: 'todo', name: 'Todo', category: 'unstarted', position: 0 },
  {
    id: 'doing',
    name: 'In Progress',
    category: 'started',
    position: 1,
    color: 'blue',
    icon: null,
  },
];

beforeEach(() => {
  listStatuses.mockReset();
  updateStatus.mockReset();
  createStatus.mockReset();
  listStatuses.mockResolvedValue(rows);
  updateStatus.mockImplementation((id) =>
    Promise.resolve(rows.find((row) => row.id === id) ?? rows[0]!)
  );
  createStatus.mockImplementation((body) =>
    Promise.resolve({ id: 'new', position: 2, ...body })
  );
});

const renderSection = (canEdit = true) =>
  render(
    <StatusesSection workspaceId="ws-1" teamId="team-1" canEdit={canEdit} />
  );

describe('the status color and icon picker', () => {
  it('opens from the keyboard and focuses the chosen color', async () => {
    const user = userEvent.setup();
    renderSection();
    const trigger = await screen.findByRole('button', {
      name: 'Change the color and icon of In Progress',
    });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', {
      name: 'Color and icon for In Progress',
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Blue' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('previews a swatch under the arrow keys and saves on Enter', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', {
        name: 'Change the color and icon of In Progress',
      })
    );
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'Blue' })).toHaveFocus();
    });
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveFocus();
    const preview = screen.getByTestId('status-appearance-preview');
    expect(preview.querySelector('svg')).toHaveStyle({ color: '#5e6ad2' });
    expect(updateStatus).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('doing', { color: 'indigo' });
    });
  });

  it('clears the color with the category default', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', {
        name: 'Change the color and icon of In Progress',
      })
    );
    await user.click(screen.getByRole('radio', { name: 'Category default' }));
    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('doing', { color: null });
    });
  });

  it('offers only the icons of the status category', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', {
        name: 'Change the color and icon of In Progress',
      })
    );
    const icons = screen.getByRole('radiogroup', { name: 'Icon' });
    expect(
      Array.from(icons.querySelectorAll('[role="radio"]')).map((cell) =>
        cell.getAttribute('aria-label')
      )
    ).toEqual([
      'Category default, progress by position',
      'Quarter',
      'Half',
      'Three quarters',
      'Paused',
      'Blocked',
    ]);
    await user.click(screen.getByRole('radio', { name: 'Paused' }));
    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('doing', { icon: 'paused' });
    });
  });

  it('adds a status with the look picked in the form', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(await screen.findByLabelText('New status'), 'Blocked');
    await user.click(
      screen.getByRole('button', {
        name: 'Change the color and icon of Blocked',
      })
    );
    await user.click(screen.getByRole('radio', { name: 'Red' }));
    await user.click(screen.getByRole('button', { name: 'Add status' }));
    await waitFor(() => {
      expect(createStatus).toHaveBeenCalledWith({
        name: 'Blocked',
        category: 'unstarted',
        position: 2,
        color: 'red',
      });
    });
  });

  it('shows a reader the glyph with no picker', async () => {
    renderSection(false);
    expect(await screen.findByText('In Progress')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Change the color and icon of In Progress',
      })
    ).not.toBeInTheDocument();
  });
});
