/**
 * The permissions section: each select shows the saved setting or its
 * default, a change is saved then re-read, and a failed save says so.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRead } from '../../types/Api';
import PermissionsSection from './PermissionsSection';

const updateWorkspace =
  vi.fn<(id: string, body: unknown) => Promise<unknown>>();
const refresh = vi.fn(() => Promise.resolve());

vi.mock('../../api/workspaces', () => ({
  updateWorkspace: (id: string, body: unknown) => updateWorkspace(id, body),
}));

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => ({ refresh }),
}));

const workspace = (fields: Partial<WorkspaceRead> = {}): WorkspaceRead => ({
  id: 'ws-1',
  name: 'Acme',
  slug: 'acme',
  plan: 'free',
  created_at: '2026-10-01T00:00:00Z',
  role: 'admin',
  ...fields,
});

beforeEach(() => {
  updateWorkspace.mockReset();
  updateWorkspace.mockResolvedValue({});
  refresh.mockClear();
});

describe('PermissionsSection', () => {
  it('shows the defaults when the workspace has never set either', () => {
    render(<PermissionsSection workspace={workspace()} />);

    expect(screen.getByLabelText('Invite members')).toHaveValue('admins');
    expect(screen.getByLabelText('Create teams')).toHaveValue('members');
  });

  it('shows the saved settings', () => {
    render(
      <PermissionsSection
        workspace={workspace({
          invite_permission: 'members',
          team_creation_permission: 'admins',
        })}
      />
    );

    expect(screen.getByLabelText('Invite members')).toHaveValue('members');
    expect(screen.getByLabelText('Create teams')).toHaveValue('admins');
  });

  it('saves a change and re-reads the workspace', async () => {
    const user = userEvent.setup();
    render(<PermissionsSection workspace={workspace()} />);

    await user.selectOptions(
      screen.getByLabelText('Invite members'),
      'members'
    );

    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        invite_permission: 'members',
      });
    });
    expect(refresh).toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Create teams'), 'admins');

    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith('ws-1', {
        team_creation_permission: 'admins',
      });
    });
  });

  it('says so when a save fails', async () => {
    updateWorkspace.mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    render(<PermissionsSection workspace={workspace()} />);

    await user.selectOptions(screen.getByLabelText('Create teams'), 'admins');

    expect(
      await screen.findByText('Could not save that permission. Try again.')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Create teams')).toHaveValue('members');
  });
});
