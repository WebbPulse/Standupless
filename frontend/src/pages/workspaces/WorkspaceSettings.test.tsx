/**
 * The workspace settings page, through both of its sections: the member roster
 * with its role and removal controls, the invite list with its create and
 * revoke, the one-time token panel, and the gate that keeps all of it away from
 * a caller who is neither an owner nor an admin.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  InviteCreatedRead,
  InviteRead,
  MemberRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import WorkspaceSettings from './WorkspaceSettings';

const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const updateMember =
  vi.fn<(userId: string, body: unknown) => Promise<unknown>>();
const removeMember = vi.fn<(userId: string) => Promise<void>>();
const listInvites = vi.fn<() => Promise<InviteRead[]>>();
const createInvite = vi.fn<(body: unknown) => Promise<InviteCreatedRead>>();
const revokeInvite = vi.fn<(inviteId: string) => Promise<void>>();

vi.mock('../../api/workspaces', () => ({
  listMembers: () => listMembers(),
  updateMember: (_workspaceId: string, userId: string, body: unknown) =>
    updateMember(userId, body),
  removeMember: (_workspaceId: string, userId: string) => removeMember(userId),
  listInvites: () => listInvites(),
  createInvite: (_workspaceId: string, body: unknown) => createInvite(body),
  revokeInvite: (_workspaceId: string, inviteId: string) =>
    revokeInvite(inviteId),
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

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** One member row as the roster route answers it. */
const member: MemberRead = {
  user_id: 'user-2',
  email: 'other@example.com',
  display_name: 'Other',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
};

/** One invite row as the invite list answers it. */
const invite: InviteRead = {
  invite_id: 'inv-1',
  email: 'invited@example.com',
  role: 'member',
  invited_by: 'user-1',
  expires_at: '2026-09-24T00:00:00Z',
  created_at: '2026-09-17T00:00:00Z',
};

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** Mounts the page inside a router, which the shell's links require. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <WorkspaceSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  listMembers.mockReset();
  updateMember.mockReset();
  removeMember.mockReset();
  listInvites.mockReset();
  createInvite.mockReset();
  revokeInvite.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listMembers.mockResolvedValue([member]);
  listInvites.mockResolvedValue([invite]);
});

describe('WorkspaceSettings access', () => {
  it('tells a member the page is not theirs rather than showing empty panels', () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(
      screen.getByText('Only an owner or an admin can manage this workspace.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Members')).not.toBeInTheDocument();
    expect(listMembers).not.toHaveBeenCalled();
  });
});

describe('the member section', () => {
  it('lists the members', async () => {
    renderPage();

    expect(await screen.findByText('Other')).toBeInTheDocument();
    expect(screen.getByText('other@example.com')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listMembers.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the members.')
    ).toBeInTheDocument();
  });

  it('changes a role through the roster select', async () => {
    updateMember.mockResolvedValue(member);
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(
      await screen.findByLabelText('Role for other@example.com'),
      'admin'
    );

    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith('user-2', { role: 'admin' });
    });
  });

  it('offers owner only to an owner, since only an owner may grant it', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    renderPage();

    const select = await screen.findByLabelText('Role for other@example.com');
    expect(
      within(select).queryByRole('option', { name: 'Owner' })
    ).not.toBeInTheDocument();
    expect(
      within(select).getByRole('option', { name: 'Admin' })
    ).toBeInTheDocument();
  });

  it('removes a member and surfaces a refusal', async () => {
    removeMember.mockRejectedValue(new Error('last owner'));
    const user = userEvent.setup();
    renderPage();

    const [firstRemove] = await screen.findAllByRole('button', {
      name: 'Remove',
    });
    if (firstRemove === undefined) throw new Error('no remove button rendered');
    await user.click(firstRemove);

    await waitFor(() => {
      expect(removeMember).toHaveBeenCalledWith('user-2');
    });
    expect(
      await screen.findByText('Could not remove that member.')
    ).toBeInTheDocument();
  });
});

describe('the invite section', () => {
  it('lists the outstanding invites', async () => {
    renderPage();

    expect(await screen.findByText('invited@example.com')).toBeInTheDocument();
  });

  it('creates an invite and shows the one-time link', async () => {
    createInvite.mockResolvedValue({ ...invite, token: 'tok-abc' });
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() => {
      expect(createInvite).toHaveBeenCalledWith({
        email: 'new@example.com',
        role: 'admin',
      });
    });
    expect(
      await screen.findByText(/This link is shown once/)
    ).toBeInTheDocument();
    expect(screen.getByText(/token=tok-abc/)).toBeInTheDocument();
  });

  it('copies the one-time link to the clipboard', async () => {
    createInvite.mockResolvedValue({ ...invite, token: 'tok-abc' });
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderPage();

    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));
    await user.click(await screen.findByRole('button', { name: 'Copy link' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining('token=tok-abc')
      );
    });
    expect(
      await screen.findByRole('button', { name: 'Copied' })
    ).toBeInTheDocument();
  });

  it('surfaces a refused create', async () => {
    createInvite.mockRejectedValue(new Error('already a member'));
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText('Email'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    expect(
      await screen.findByText('Could not create the invite.')
    ).toBeInTheDocument();
  });

  it('revokes an invite', async () => {
    revokeInvite.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(revokeInvite).toHaveBeenCalledWith('inv-1');
    });
  });
});
