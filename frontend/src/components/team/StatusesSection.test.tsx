/**
 * The team statuses section. Covers the color and icon picker (the glyph opens
 * a panel reachable from the keyboard, a swatch previews before it saves, the
 * default clears the field, a new status gets a look of its own), the grouping
 * by category, and the team overrides on a status inherited from the
 * workspace: hide, show, rename, reset and the refusals the API answers.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OverrideUpdate,
  StatusCreate,
  StatusRead,
  StatusUpdate,
} from '../../types/Api';
import StatusesSection from './StatusesSection';

const listStatuses = vi.fn<() => Promise<StatusRead[]>>();
const updateStatus =
  vi.fn<(statusId: string, body: StatusUpdate) => Promise<StatusRead>>();
const createStatus = vi.fn<(body: StatusCreate) => Promise<StatusRead>>();
const overrideStatus =
  vi.fn<(statusId: string, body: OverrideUpdate) => Promise<StatusRead>>();
const resetStatusOverride = vi.fn<(statusId: string) => Promise<StatusRead>>();
const listOptions = vi.fn<(options: unknown) => void>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listStatuses: (
      _w: string,
      _t: string,
      _signal: AbortSignal | undefined,
      options: unknown
    ) => {
      listOptions(options);
      return listStatuses();
    },
    overrideStatus: (
      _w: string,
      _t: string,
      id: string,
      body: OverrideUpdate
    ) => overrideStatus(id, body),
    resetStatusOverride: (_w: string, _t: string, id: string) =>
      resetStatusOverride(id),
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

/** A completed status the team inherits and has left alone. */
const shipped: StatusRead = {
  id: 'ws-done',
  name: 'Shipped',
  category: 'completed',
  position: 5,
  scope: 'workspace',
  hidden: false,
  inherited_name: null,
};

/** A cancelled status the team inherits and hid. */
const dropped: StatusRead = {
  id: 'ws-dropped',
  name: 'Dropped',
  category: 'cancelled',
  position: 6,
  scope: 'workspace',
  hidden: true,
  inherited_name: null,
};

/** A started status the team inherits under a name of its own. */
const review: StatusRead = {
  id: 'ws-review',
  name: 'Code review',
  category: 'started',
  position: 4,
  scope: 'workspace',
  hidden: false,
  inherited_name: 'In Review',
};

beforeEach(() => {
  listStatuses.mockReset();
  updateStatus.mockReset();
  createStatus.mockReset();
  overrideStatus.mockReset();
  resetStatusOverride.mockReset();
  listOptions.mockReset();
  overrideStatus.mockImplementation((id) =>
    Promise.resolve(shipped.id === id ? shipped : dropped)
  );
  resetStatusOverride.mockResolvedValue(review);
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
    <MemoryRouter>
      <StatusesSection
        workspaceId="ws-1"
        teamId="team-1"
        slug="mine"
        canEdit={canEdit}
      />
    </MemoryRouter>
  );

/** Opens the row menu of the named status. */
const openActions = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string
) => {
  await user.click(
    await screen.findByRole('button', { name: `Actions for ${name}` })
  );
};

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
    await user.click(
      await screen.findByRole('button', { name: 'Add status to Unstarted' })
    );
    await user.type(screen.getByLabelText('New status'), 'Blocked');
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

describe('the category groups', () => {
  it('lists every category with its statuses under it', async () => {
    renderSection();
    const started = await screen.findByRole('region', { name: 'Started' });
    expect(
      within(started).getByDisplayValue('In Progress')
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Backlog' })).getByText(
        'No backlog statuses.'
      )
    ).toBeInTheDocument();
  });

  it('reads the list with the hidden statuses included', async () => {
    renderSection();
    await screen.findByDisplayValue('Todo');
    expect(listOptions).toHaveBeenCalledWith({ includeHidden: true });
  });

  it('moves a status to another category from its menu', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Todo');
    await user.click(screen.getByRole('menuitem', { name: 'Started' }));
    await waitFor(() => {
      expect(updateStatus).toHaveBeenCalledWith('todo', {
        category: 'started',
      });
    });
  });
});

describe('an inherited status', () => {
  beforeEach(() => {
    listStatuses.mockResolvedValue([...rows, review, shipped, dropped]);
  });

  it('carries the Workspace marker and cannot be edited in place', async () => {
    renderSection();
    const completed = await screen.findByRole('region', { name: 'Completed' });
    expect(within(completed).getByText('Shipped')).toBeInTheDocument();
    expect(within(completed).getByText('Workspace')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Change the color and icon of Shipped',
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Move Shipped up' })
    ).not.toBeInTheDocument();
  });

  it('shows the workspace name beside a local rename', async () => {
    renderSection();
    expect(
      await screen.findByText('Workspace name: In Review')
    ).toBeInTheDocument();
  });

  it('points at workspace settings for an edit', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Shipped');
    expect(
      screen.getByRole('menuitem', { name: 'Edit in workspace settings' })
    ).toHaveAttribute('href', '/w/mine/settings/workflow');
  });

  it('hides a status from the team', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Shipped');
    await user.click(
      screen.getByRole('menuitem', { name: 'Hide from this team' })
    );
    await waitFor(() => {
      expect(overrideStatus).toHaveBeenCalledWith('ws-done', { hidden: true });
    });
  });

  it('keeps a hidden status out of view until asked, then shows it again', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText('Shipped');
    expect(screen.queryByText('Dropped')).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Show hidden (1)'));
    expect(screen.getByText('Dropped')).toBeInTheDocument();
    expect(screen.getByText('Hidden')).toBeInTheDocument();
    await openActions(user, 'Dropped');
    await user.click(
      screen.getByRole('menuitem', { name: 'Show in this team' })
    );
    await waitFor(() => {
      expect(overrideStatus).toHaveBeenCalledWith('ws-dropped', {
        hidden: false,
      });
    });
  });

  it('renames a status for the team only', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Shipped');
    await user.click(
      screen.getByRole('menuitem', { name: 'Rename for this team' })
    );
    const field = await screen.findByLabelText('Name in this team');
    await user.clear(field);
    await user.type(field, 'Released');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(overrideStatus).toHaveBeenCalledWith('ws-done', {
        name: 'Released',
      });
    });
  });

  it('clears the rename when the workspace name is typed back', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Code review');
    await user.click(
      screen.getByRole('menuitem', { name: 'Rename for this team' })
    );
    const field = await screen.findByLabelText('Name in this team');
    await user.clear(field);
    await user.type(field, 'In Review');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(overrideStatus).toHaveBeenCalledWith('ws-review', { name: null });
    });
  });

  it('resets an overridden status and offers no reset otherwise', async () => {
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Shipped');
    expect(
      screen.getByRole('menuitem', { name: 'Reset to workspace' })
    ).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Escape}');
    await openActions(user, 'Code review');
    await user.click(
      screen.getByRole('menuitem', { name: 'Reset to workspace' })
    );
    await waitFor(() => {
      expect(resetStatusOverride).toHaveBeenCalledWith('ws-review');
    });
  });

  it('says why the API refused to hide the last visible status', async () => {
    overrideStatus.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          error_code: 'LAST_VISIBLE',
          message:
            'A team must keep one visible status in each category it uses',
        },
        url: '/api/workspaces/ws-1/teams/team-1/statuses/ws-done/override',
        method: 'PATCH',
      })
    );
    const user = userEvent.setup();
    renderSection();
    await openActions(user, 'Shipped');
    await user.click(
      screen.getByRole('menuitem', { name: 'Hide from this team' })
    );
    expect(
      await screen.findByText(
        'A team must keep one visible status in each category it uses'
      )
    ).toBeInTheDocument();
  });

  it('gives a reader the markers and no actions', async () => {
    renderSection(false);
    expect(await screen.findByText('Shipped')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Shipped' })
    ).not.toBeInTheDocument();
  });
});

describe('a status inherited from the parent team', () => {
  const triaged: StatusRead = {
    id: 'parent-triaged',
    name: 'Triaged',
    category: 'unstarted',
    position: 3,
    scope: 'parent',
    hidden: false,
    inherited_name: null,
  };

  beforeEach(() => {
    listStatuses.mockResolvedValue([...rows, triaged]);
  });

  it('links to the parent team settings for an edit', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StatusesSection
          workspaceId="ws-1"
          teamId="team-1"
          slug="mine"
          parentSettingsPath="/w/mine/team/PLAT/settings"
          canEdit
        />
      </MemoryRouter>
    );
    await openActions(user, 'Triaged');
    expect(
      screen.getByRole('menuitem', { name: 'Edit in parent team settings' })
    ).toHaveAttribute(
      'href',
      '/w/mine/team/PLAT/settings#team-settings-workflow'
    );
    expect(
      screen.queryByRole('menuitem', { name: 'Edit in workspace settings' })
    ).not.toBeInTheDocument();
  });
});
