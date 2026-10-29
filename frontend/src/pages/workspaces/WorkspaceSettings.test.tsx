/**
 * The workspace settings page, through both of its sections: the member roster
 * with its role and removal controls, the invite list with its create and
 * revoke, the one-time token panel, and the gate that keeps all of it away from
 * a caller who is neither an owner nor an admin, the logo upload and removal,
 * the project update cadence, the danger zone's typed name, step-up, scheduled banner and cancel,
 * and its Leave workspace row, offered to a member and held back from the last owner.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, type AnyAuthClient } from '@webbpulse/auth/react';
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
const listMemberDirectory =
  vi.fn<(statuses: readonly string[]) => Promise<MemberRead[]>>();
const suspendMember = vi.fn<(userId: string) => Promise<unknown>>();
const updateMember =
  vi.fn<(userId: string, body: unknown) => Promise<unknown>>();
const removeMember = vi.fn<(userId: string) => Promise<void>>();
const listInvites = vi.fn<() => Promise<InviteRead[]>>();
const createInvite = vi.fn<(body: unknown) => Promise<InviteCreatedRead>>();
const revokeInvite = vi.fn<(inviteId: string) => Promise<void>>();
const scheduleWorkspaceDeletion = vi.fn<(body: unknown) => Promise<unknown>>();
const cancelWorkspaceDeletion = vi.fn<() => Promise<unknown>>();
const stepUpWithPasskey = vi.fn<() => Promise<unknown>>();
const stepUp = vi.fn<(input: { code: string }) => Promise<unknown>>();
const uploadIcon = vi.fn<(path: string, file: File) => Promise<unknown>>();
const clearIcon = vi.fn<(path: string) => Promise<unknown>>();
const updateWorkspace = vi.fn<(body: unknown) => Promise<unknown>>();

vi.mock('../../api/icons', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/icons')>('../../api/icons');
  return {
    ...actual,
    workspaceIcon: (workspaceId: string) => ({
      path: actual.workspaceIconPath(workspaceId),
      clear: () => clearIcon(actual.workspaceIconPath(workspaceId)),
    }),
    uploadIcon: (owner: { path: string }, file: File) =>
      uploadIcon(owner.path, file),
  };
});

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({
    stepUpWithPasskey: () => stepUpWithPasskey(),
    stepUp: (input: { code: string }) => stepUp(input),
  }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: {
      id: 'user-1',
      email: 'someone@example.com',
      display_name: 'Someone',
      email_verified: true,
    },
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/workspaces', () => ({
  listMembers: () => listMembers(),
  listMemberDirectory: (_workspaceId: string, statuses: readonly string[]) =>
    listMemberDirectory(statuses),
  suspendMember: (_workspaceId: string, userId: string) =>
    suspendMember(userId),
  reactivateMember: () => Promise.resolve({}),
  updateMember: (_workspaceId: string, userId: string, body: unknown) =>
    updateMember(userId, body),
  removeMember: (_workspaceId: string, userId: string) => removeMember(userId),
  listInvites: () => listInvites(),
  createInvite: (_workspaceId: string, body: unknown) => createInvite(body),
  revokeInvite: (_workspaceId: string, inviteId: string) =>
    revokeInvite(inviteId),
  scheduleWorkspaceDeletion: (_workspaceId: string, body: unknown) =>
    scheduleWorkspaceDeletion(body),
  cancelWorkspaceDeletion: () => cancelWorkspaceDeletion(),
  updateWorkspace: (_workspaceId: string, body: unknown) =>
    updateWorkspace(body),
  getInviteLink: () =>
    Promise.resolve({ enabled: false, created_by: null, created_at: null }),
  resetInviteLink: () =>
    Promise.resolve({
      enabled: true,
      created_by: null,
      created_at: null,
      token: 'token',
    }),
  disableInviteLink: () => Promise.resolve(undefined),
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

vi.mock('../../hooks/useMyStatus', () => ({
  useMyStatus: () => ({
    status: null,
    saving: false,
    error: null,
    save: () => Promise.resolve(true),
    clear: () => Promise.resolve(true),
  }),
}));

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
const resolved = (
  role: WorkspaceRole,
  purgeAfter: string | null = null,
  invitePermission: WorkspaceRead['invite_permission'] = 'admins'
): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
    purge_after: purgeAfter,
    invite_permission: invitePermission,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

const authState = { sessionEnded: null };

/** The client the shared step-up reads from context. */
const fakeClient = {
  subscribe: () => () => undefined,
  getState: () => authState,
  initialize: () => Promise.resolve(),
  stepUpWithPasskey: () => stepUpWithPasskey(),
  stepUp: (input: { code: string }) => stepUp(input),
};

/** Mounts the page inside a router, which the shell's links require. */
const renderPage = () =>
  render(
    <AuthProvider
      client={fakeClient as unknown as AnyAuthClient}
      initializeOnMount={false}
    >
      <MemoryRouter>
        <WorkspaceSettings />
      </MemoryRouter>
    </AuthProvider>
  );

beforeEach(() => {
  listMembers.mockReset();
  listMemberDirectory.mockReset();
  suspendMember.mockReset();
  updateMember.mockReset();
  removeMember.mockReset();
  listInvites.mockReset();
  createInvite.mockReset();
  revokeInvite.mockReset();
  useWorkspaceMock.mockReset();
  scheduleWorkspaceDeletion.mockReset();
  cancelWorkspaceDeletion.mockReset();
  stepUpWithPasskey.mockReset();
  stepUp.mockReset();
  useWorkspaceMock.mockReturnValue(resolved('owner'));
  listMembers.mockResolvedValue([member]);
  listMemberDirectory.mockResolvedValue([member]);
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
    expect(screen.queryByText('Invite someone')).not.toBeInTheDocument();
  });

  it('gives a member the invite form alone when the workspace lets members invite', async () => {
    createInvite.mockResolvedValue({ ...invite, token: 'tok-abc' });
    useWorkspaceMock.mockReturnValue(resolved('member', null, 'members'));
    const user = userEvent.setup();
    renderPage();

    const roles = screen.getByLabelText('Role');
    expect(
      Array.from(roles.querySelectorAll('option')).map((item) => item.value)
    ).toEqual(['member', 'guest']);
    expect(listInvites).not.toHaveBeenCalled();
    expect(screen.queryByText('Members')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.selectOptions(roles, 'guest');
    await user.click(screen.getByRole('button', { name: 'Create invite' }));

    await waitFor(() => {
      expect(createInvite).toHaveBeenCalledWith({
        email: 'new@example.com',
        role: 'guest',
      });
    });
  });

  it('never gives a guest the invite form', () => {
    useWorkspaceMock.mockReturnValue(resolved('guest', null, 'members'));
    renderPage();

    expect(screen.queryByText('Invite someone')).not.toBeInTheDocument();
  });
});

describe('the logo section', () => {
  it('uploads a logo to the workspace icon path and re-reads the workspace', async () => {
    const context = resolved('admin');
    useWorkspaceMock.mockReturnValue(context);
    uploadIcon.mockResolvedValue({});
    URL.createObjectURL = () => 'blob:preview';
    URL.revokeObjectURL = () => undefined;
    renderPage();

    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    await userEvent.upload(
      screen.getByLabelText('Choose workspace logo image'),
      file
    );

    await waitFor(() => {
      expect(uploadIcon).toHaveBeenCalledWith('/workspaces/ws-1/icon', file);
    });
    await waitFor(() => {
      expect(context.refresh).toHaveBeenCalled();
    });
  });

  it('removes a set logo', async () => {
    const context = resolved('owner');
    context.workspace = {
      ...(context.workspace as WorkspaceRead),
      icon_url: 'https://api/icons/workspace/ws-1/abc',
    };
    useWorkspaceMock.mockReturnValue(context);
    clearIcon.mockResolvedValue({});
    renderPage();

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(clearIcon).toHaveBeenCalledWith('/workspaces/ws-1/icon');
    await waitFor(() => {
      expect(context.refresh).toHaveBeenCalled();
    });
  });
});

describe('the project updates section', () => {
  it('saves a new default cadence and re-reads the workspace', async () => {
    const context = resolved('admin');
    useWorkspaceMock.mockReturnValue(context);
    updateWorkspace.mockResolvedValue({});
    renderPage();

    const select = screen.getByLabelText('Default cadence');
    expect(select).toHaveValue('7');
    await userEvent.selectOptions(select, '14');

    await waitFor(() => {
      expect(updateWorkspace).toHaveBeenCalledWith({
        project_update_interval_days: 14,
      });
    });
    await waitFor(() => {
      expect(context.refresh).toHaveBeenCalled();
    });
  });
});

describe('the member section', () => {
  /** Opens the overflow menu on the row for Other. */
  const openRowMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Other' })
    );
    return screen.getByRole('menu');
  };

  it('lists the members, invites and suspensions included', async () => {
    renderPage();

    expect(await screen.findByText('Other')).toBeInTheDocument();
    expect(screen.getByText('other@example.com')).toBeInTheDocument();
    expect(listMemberDirectory).toHaveBeenCalledWith([
      'active',
      'invited',
      'suspended',
    ]);
  });

  it('surfaces a failed read', async () => {
    listMemberDirectory.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load the members.')
    ).toBeInTheDocument();
  });

  it('changes a role from the row menu', async () => {
    updateMember.mockResolvedValue(member);
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'Admin' }));

    await waitFor(() => {
      expect(updateMember).toHaveBeenCalledWith('user-2', { role: 'admin' });
    });
  });

  it('offers owner only to an owner, since only an owner may grant it', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu(user);
    expect(
      within(menu).queryByRole('menuitem', { name: 'Owner' })
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'Admin' })
    ).toBeInTheDocument();
  });

  it('suspends a member after a confirmation', async () => {
    suspendMember.mockResolvedValue({ ...member, status: 'suspended' });
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu(user);
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Suspend user' })
    );
    const dialog = screen.getByRole('dialog', { name: 'Suspend Other' });
    expect(
      within(dialog).getByText(/lose access to Mine at once/)
    ).toBeInTheDocument();
    expect(suspendMember).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole('button', { name: 'Suspend user' })
    );

    await waitFor(() => {
      expect(suspendMember).toHaveBeenCalledWith('user-2');
    });
  });

  it('removes a member and surfaces a refusal', async () => {
    removeMember.mockRejectedValue(new Error('last owner'));
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu(user);
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Remove from workspace' })
    );

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

describe('the danger zone', () => {
  /** Opens the dialog and types `name` into the confirmation. */
  const openAndType = async (
    user: ReturnType<typeof userEvent.setup>,
    name: string
  ) => {
    await user.click(
      await screen.findByRole('button', { name: 'Delete workspace' })
    );
    const dialog = screen.getByRole('dialog');
    await user.type(
      within(dialog).getByLabelText('Type Mine to confirm'),
      name
    );
    return dialog;
  };

  it('is shown to an admin as well as an owner, and says the grace period', async () => {
    useWorkspaceMock.mockReturnValue(resolved('admin'));
    renderPage();

    expect(await screen.findByText('Danger zone')).toBeInTheDocument();
    expect(screen.getByText(/after 14 days/)).toBeInTheDocument();
  });

  it('keeps the button disabled until the name is typed exactly', async () => {
    const user = userEvent.setup();
    renderPage();

    const dialog = await openAndType(user, 'mine');
    const submit = within(dialog).getByRole('button', {
      name: 'Schedule deletion',
    });
    expect(submit).toBeDisabled();

    await user.clear(within(dialog).getByLabelText('Type Mine to confirm'));
    await user.type(
      within(dialog).getByLabelText('Type Mine to confirm'),
      'Mine'
    );
    expect(submit).toBeEnabled();
  });

  it('steps up with a passkey and then schedules, refreshing the workspace', async () => {
    const context = resolved('owner');
    useWorkspaceMock.mockReturnValue(context);
    stepUpWithPasskey.mockResolvedValue({ ok: true, expiresIn: 900 });
    scheduleWorkspaceDeletion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    const dialog = await openAndType(user, 'Mine');
    await user.click(
      within(dialog).getByRole('button', { name: 'Schedule deletion' })
    );

    await waitFor(() => {
      expect(scheduleWorkspaceDeletion).toHaveBeenCalledWith({
        confirm_name: 'Mine',
      });
    });
    expect(stepUpWithPasskey).toHaveBeenCalledTimes(1);
    expect(context.refresh).toHaveBeenCalled();
  });

  it('asks for a code when the account has no passkey', async () => {
    stepUpWithPasskey.mockResolvedValue({
      ok: false,
      reason: 'no-passkeys',
      message: 'No passkeys.',
    });
    stepUp.mockResolvedValue({ ok: true, expiresIn: 900 });
    scheduleWorkspaceDeletion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    const dialog = await openAndType(user, 'Mine');
    await user.click(
      within(dialog).getByRole('button', { name: 'Schedule deletion' })
    );
    expect(scheduleWorkspaceDeletion).not.toHaveBeenCalled();

    await user.type(
      await within(dialog).findByLabelText('Authenticator or recovery code'),
      '123456'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Verify and schedule' })
    );

    await waitFor(() => {
      expect(scheduleWorkspaceDeletion).toHaveBeenCalledTimes(1);
    });
    expect(stepUp).toHaveBeenCalledWith({ code: '123456' });
  });

  it('shows a refused code and does not schedule', async () => {
    stepUpWithPasskey.mockResolvedValue({
      ok: false,
      reason: 'no-passkeys',
      message: 'No passkeys.',
    });
    stepUp.mockResolvedValue({
      ok: false,
      reason: 'invalid-code',
      message: 'That code is not valid.',
    });
    const user = userEvent.setup();
    renderPage();

    const dialog = await openAndType(user, 'Mine');
    await user.click(
      within(dialog).getByRole('button', { name: 'Schedule deletion' })
    );
    await user.type(
      await within(dialog).findByLabelText('Authenticator or recovery code'),
      '000000'
    );
    await user.click(
      within(dialog).getByRole('button', { name: 'Verify and schedule' })
    );

    expect(
      await within(dialog).findByText('That code is not valid.')
    ).toBeInTheDocument();
    expect(scheduleWorkspaceDeletion).not.toHaveBeenCalled();
  });

  it('lets a person with no second factor carry on with the typed name alone', async () => {
    stepUpWithPasskey.mockResolvedValue({
      ok: false,
      reason: 'no-passkeys',
      message: 'No passkeys.',
    });
    scheduleWorkspaceDeletion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    const dialog = await openAndType(user, 'Mine');
    await user.click(
      within(dialog).getByRole('button', { name: 'Schedule deletion' })
    );
    await user.click(
      await within(dialog).findByRole('button', {
        name: 'I do not use a passkey or an authenticator app',
      })
    );

    await waitFor(() => {
      expect(scheduleWorkspaceDeletion).toHaveBeenCalledTimes(1);
    });
  });

  it('shows the date and cancels a scheduled deletion', async () => {
    const context = resolved('owner', '2026-10-10T12:00:00Z');
    useWorkspaceMock.mockReturnValue(context);
    cancelWorkspaceDeletion.mockResolvedValue({});
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByText(/will be permanently deleted on/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel deletion' }));

    await waitFor(() => {
      expect(cancelWorkspaceDeletion).toHaveBeenCalledTimes(1);
    });
    expect(context.refresh).toHaveBeenCalled();
  });
});

describe('the Leave workspace row', () => {
  it('lets a member leave after confirming in a dialog that names the workspace', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    removeMember.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Leave workspace' }));
    const dialog = screen.getByRole('dialog', { name: 'Leave Mine' });
    await user.click(
      within(dialog).getByRole('button', { name: 'Leave workspace' })
    );

    await waitFor(() => {
      expect(removeMember).toHaveBeenCalledWith('user-1');
    });
    expect(listMembers).not.toHaveBeenCalled();
  });

  it('is disabled for the last owner, with the reason', async () => {
    renderPage();

    expect(
      await screen.findByText(
        'You are the only owner of Mine. Make another member an owner before you leave.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Leave workspace' })
    ).toBeDisabled();
  });

  it('is open to an owner while another owner remains', async () => {
    listMembers.mockResolvedValue([
      { ...member, user_id: 'user-1', role: 'owner' },
      { ...member, role: 'owner' },
    ]);
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Leave workspace' })
      ).toBeEnabled();
    });
  });
});
