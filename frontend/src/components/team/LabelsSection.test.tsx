/**
 * The team labels section: the team's own labels are added, recolored and
 * renamed in place, and a label inherited from the workspace carries its
 * marker and only the team overrides, with the API's refusal shown in words.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LabelCreate,
  LabelRead,
  LabelUpdate,
  OverrideUpdate,
} from '../../types/Api';
import LabelsSection from './LabelsSection';

const listLabels = vi.fn<() => Promise<LabelRead[]>>();
const createLabel = vi.fn<(body: LabelCreate) => Promise<LabelRead>>();
const updateLabel =
  vi.fn<(labelId: string, body: LabelUpdate) => Promise<LabelRead>>();
const overrideLabel =
  vi.fn<(labelId: string, body: OverrideUpdate) => Promise<LabelRead>>();
const resetLabelOverride = vi.fn<(labelId: string) => Promise<LabelRead>>();

vi.mock('../../api/teams', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/teams')>('../../api/teams');
  return {
    ...actual,
    listLabels: () => listLabels(),
    createLabel: (_w: string, _t: string, body: LabelCreate) =>
      createLabel(body),
    updateLabel: (_w: string, _t: string, id: string, body: LabelUpdate) =>
      updateLabel(id, body),
    overrideLabel: (_w: string, _t: string, id: string, body: OverrideUpdate) =>
      overrideLabel(id, body),
    resetLabelOverride: (_w: string, _t: string, id: string) =>
      resetLabelOverride(id),
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

/** A label the team owns. */
const bug: LabelRead = { id: 'bug', name: 'Bug', color: '#e5484d' };

/** A label the team inherits from the workspace. */
const security: LabelRead = {
  id: 'ws-security',
  name: 'Security',
  color: '#8b5cd6',
  scope: 'workspace',
  hidden: false,
  inherited_name: null,
};

/** A label the team inherits and hid. */
const legacy: LabelRead = {
  id: 'ws-legacy',
  name: 'Legacy',
  color: '#8b919c',
  scope: 'workspace',
  hidden: true,
  inherited_name: null,
};

beforeEach(() => {
  listLabels.mockReset();
  createLabel.mockReset();
  updateLabel.mockReset();
  overrideLabel.mockReset();
  resetLabelOverride.mockReset();
  listLabels.mockResolvedValue([bug, security, legacy]);
  createLabel.mockImplementation((body) =>
    Promise.resolve({ id: 'new', ...body })
  );
  updateLabel.mockResolvedValue(bug);
  overrideLabel.mockResolvedValue(security);
  resetLabelOverride.mockResolvedValue(security);
});

const renderSection = (canEdit = true) =>
  render(
    <MemoryRouter>
      <LabelsSection
        workspaceId="ws-1"
        teamId="team-1"
        slug="mine"
        canEdit={canEdit}
      />
    </MemoryRouter>
  );

describe('the team labels', () => {
  it('adds a label with a palette color', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.type(await screen.findByLabelText('New label'), 'Docs');
    await user.click(
      screen.getByRole('button', { name: 'Change the color of Docs' })
    );
    await user.click(screen.getByRole('radio', { name: 'Green' }));
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    await waitFor(() => {
      expect(createLabel).toHaveBeenCalledWith({
        name: 'Docs',
        color: '#2f9e62',
      });
    });
  });

  it('recolors a label with a hex of its own', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Change the color of Bug' })
    );
    const hex = screen.getByLabelText('Hex color');
    await user.clear(hex);
    await user.type(hex, '#123abc{Enter}');
    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('bug', { color: '#123abc' });
    });
  });

  it('renames a team label in place', async () => {
    const user = userEvent.setup();
    renderSection();
    const field = await screen.findByLabelText('Name of Bug');
    await user.clear(field);
    await user.type(field, 'Defect{Enter}');
    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('bug', { name: 'Defect' });
    });
  });
});

describe('an inherited label', () => {
  it('carries the Workspace marker and no inline editor', async () => {
    renderSection();
    expect(await screen.findByText('Security')).toBeInTheDocument();
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change the color of Security' })
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy')).not.toBeInTheDocument();
  });

  it('hides, renames and resets for the team', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Security' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Hide from this team' })
    );
    await waitFor(() => {
      expect(overrideLabel).toHaveBeenCalledWith('ws-security', {
        hidden: true,
      });
    });

    await user.click(
      screen.getByRole('button', { name: 'Actions for Security' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Rename for this team' })
    );
    const field = await screen.findByLabelText('Name in this team');
    await user.clear(field);
    await user.type(field, 'Sec');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(overrideLabel).toHaveBeenCalledWith('ws-security', {
        name: 'Sec',
      });
    });
  });

  it('shows a hidden label on request and brings it back', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByLabelText('Show hidden (1)'));
    await user.click(
      screen.getByRole('button', { name: 'Actions for Legacy' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Show in this team' })
    );
    await waitFor(() => {
      expect(overrideLabel).toHaveBeenCalledWith('ws-legacy', {
        hidden: false,
      });
    });
    await user.click(
      screen.getByRole('button', { name: 'Actions for Legacy' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Reset to workspace' })
    );
    await waitFor(() => {
      expect(resetLabelOverride).toHaveBeenCalledWith('ws-legacy');
    });
  });

  it('shows the refusal when an inherited label is edited through the team', async () => {
    overrideLabel.mockRejectedValue(
      new ApiError({
        status: 409,
        statusText: 'Conflict',
        body: {
          error_code: 'INHERITED_LABEL',
          message:
            'This label comes from the workspace. Change it in the workspace, or hide or rename it for the team.',
        },
        url: '/api/workspaces/ws-1/teams/team-1/labels/ws-security/override',
        method: 'PATCH',
      })
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Security' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Hide from this team' })
    );
    expect(
      await screen.findByText(
        'This label comes from the workspace. Change it in the workspace, or hide or rename it for the team.'
      )
    ).toBeInTheDocument();
  });

  it('points at workspace settings for an edit', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Security' })
    );
    expect(
      screen.getByRole('menuitem', { name: 'Edit in workspace settings' })
    ).toHaveAttribute('href', '/w/mine/settings/labels');
  });
});

describe('label groups', () => {
  /** A group the team owns, with one label in it. */
  const area: LabelRead = {
    id: 'area',
    name: 'Area',
    color: '#8b919c',
    is_group: true,
    parent_id: null,
  };
  const frontend: LabelRead = {
    id: 'frontend',
    name: 'Frontend',
    color: '#2f9e62',
    parent_id: 'area',
  };

  beforeEach(() => {
    listLabels.mockResolvedValue([bug, area, frontend]);
  });

  it('lists a group with its labels under it', async () => {
    renderSection();
    const rows = (await screen.findAllByRole('listitem')).map(
      (row) => row.querySelector('input')?.value
    );
    expect(rows).toEqual(['Bug', 'Area', 'Frontend']);
    expect(screen.getByLabelText('Label group')).toBeInTheDocument();
  });

  it('adds a group and a label inside it', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(await screen.findByLabelText('Kind'), 'group');
    await user.type(screen.getByLabelText('New label'), 'Type');
    await user.click(screen.getByRole('button', { name: 'Add group' }));
    await waitFor(() => {
      expect(createLabel).toHaveBeenCalledWith({
        name: 'Type',
        color: '#3b7cf0',
        is_group: true,
      });
    });

    await user.selectOptions(screen.getByLabelText('Kind'), 'label');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Group' }),
      'area'
    );
    await user.type(screen.getByLabelText('New label'), 'Backend');
    await user.click(screen.getByRole('button', { name: 'Add label' }));
    await waitFor(() => {
      expect(createLabel).toHaveBeenLastCalledWith(
        expect.objectContaining({ name: 'Backend', parent_id: 'area' })
      );
    });
  });

  it('moves a label into a group and back out', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Bug' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Move to Area' }));
    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('bug', { parent_id: 'area' });
    });

    await user.click(
      screen.getByRole('button', { name: 'Actions for Frontend' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Remove from group' })
    );
    await waitFor(() => {
      expect(updateLabel).toHaveBeenCalledWith('frontend', {
        parent_id: null,
      });
    });
  });

  it('asks before deleting a group and says its labels stay', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Area' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete group' }));
    expect(
      await screen.findByText('Its labels stay, outside any group.')
    ).toBeInTheDocument();
  });
});
