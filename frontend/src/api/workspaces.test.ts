/**
 * The workspace, member and invite contract the frontend depends on: the
 * backend answers a plural envelope on every list, and each call spends the
 * path the contract fixes. The envelopes are pinned here because a bare array
 * would type-check identically at the call site and fail only at runtime.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  invitesPath,
  listInvites,
  listMembers,
  listWorkspaces,
  membersPath,
  removeMember,
  revokeInvite,
  updateMember,
  updateWorkspace,
  workspacePath,
  INVITE_ACCEPT_PATH,
  WORKSPACES_PATH,
} from './workspaces';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

/** One workspace row in exactly the shape the backend serialises. */
const workspace = {
  id: 'ws-mine',
  name: 'Mine',
  slug: 'mine',
  plan: 'free',
  created_at: '2026-09-17T00:00:00Z',
  role: 'owner',
};

/** One member row in exactly the shape the backend serialises. */
const member = {
  user_id: 'user-1',
  email: 'someone@example.com',
  display_name: 'Someone',
  role: 'member',
  joined_at: '2026-09-17T00:00:00Z',
};

/** One invite row in exactly the shape the backend serialises. */
const invite = {
  invite_id: 'inv-1',
  email: 'someone@example.com',
  role: 'member',
  invited_by: 'user-0',
  expires_at: '2026-09-24T00:00:00Z',
  created_at: '2026-09-17T00:00:00Z',
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('listWorkspaces', () => {
  it('reads the items out of the envelope', async () => {
    get.mockResolvedValue({ data: { workspaces: [workspace] } });

    await expect(listWorkspaces()).resolves.toEqual([workspace]);
  });

  it('asks for the workspaces route', async () => {
    get.mockResolvedValue({ data: { workspaces: [] } });

    await listWorkspaces();

    expect(get).toHaveBeenCalledWith(WORKSPACES_PATH, undefined);
  });

  it('passes an abort signal through when one is given', async () => {
    get.mockResolvedValue({ data: { workspaces: [] } });
    const controller = new AbortController();

    await listWorkspaces(controller.signal);

    expect(get).toHaveBeenCalledWith(WORKSPACES_PATH, {
      signal: controller.signal,
    });
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listWorkspaces()).resolves.toEqual([]);
  });

  it('answers an empty list rather than throwing on a bare array body', async () => {
    get.mockResolvedValue({ data: [workspace] });

    await expect(listWorkspaces()).resolves.toEqual([]);
  });
});

describe('createWorkspace', () => {
  it('posts the name and slug and answers the created workspace', async () => {
    post.mockResolvedValue({ data: workspace });

    await expect(
      createWorkspace({ name: 'Mine', slug: 'mine' })
    ).resolves.toEqual(workspace);
    expect(post).toHaveBeenCalledWith(
      WORKSPACES_PATH,
      { name: 'Mine', slug: 'mine' },
      undefined
    );
  });

  it('rejects when the API refuses the slug', async () => {
    post.mockRejectedValue(new Error('slug taken'));

    await expect(
      createWorkspace({ name: 'Mine', slug: 'mine' })
    ).rejects.toThrow('slug taken');
  });
});

describe('the single workspace routes', () => {
  it('reads one workspace by id', async () => {
    get.mockResolvedValue({ data: workspace });

    await expect(getWorkspace('ws-mine')).resolves.toEqual(workspace);
    expect(get).toHaveBeenCalledWith(workspacePath('ws-mine'), undefined);
  });

  it('patches only the fields it is given', async () => {
    patch.mockResolvedValue({ data: workspace });

    await updateWorkspace('ws-mine', { name: 'Renamed' });

    expect(patch).toHaveBeenCalledWith(
      workspacePath('ws-mine'),
      { name: 'Renamed' },
      undefined
    );
  });

  it('deletes a workspace by id', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteWorkspace('ws-mine');

    expect(del).toHaveBeenCalledWith(workspacePath('ws-mine'), undefined);
  });
});

describe('the member routes', () => {
  it('reads the members out of the envelope', async () => {
    get.mockResolvedValue({ data: { members: [member] } });

    await expect(listMembers('ws-mine')).resolves.toEqual([member]);
    expect(get).toHaveBeenCalledWith(membersPath('ws-mine'), undefined);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listMembers('ws-mine')).resolves.toEqual([]);
  });

  it('patches one member role', async () => {
    patch.mockResolvedValue({ data: member });

    await updateMember('ws-mine', 'user-1', { role: 'admin' });

    expect(patch).toHaveBeenCalledWith(
      `${membersPath('ws-mine')}/user-1`,
      { role: 'admin' },
      undefined
    );
  });

  it('removes one member', async () => {
    del.mockResolvedValue({ data: undefined });

    await removeMember('ws-mine', 'user-1');

    expect(del).toHaveBeenCalledWith(
      `${membersPath('ws-mine')}/user-1`,
      undefined
    );
  });

  it('surfaces the refusal when the last owner cannot be removed', async () => {
    del.mockRejectedValue(new Error('last owner'));

    await expect(removeMember('ws-mine', 'user-1')).rejects.toThrow(
      'last owner'
    );
  });
});

describe('the invite routes', () => {
  it('reads the invites out of the envelope', async () => {
    get.mockResolvedValue({ data: { invites: [invite] } });

    await expect(listInvites('ws-mine')).resolves.toEqual([invite]);
    expect(get).toHaveBeenCalledWith(invitesPath('ws-mine'), undefined);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listInvites('ws-mine')).resolves.toEqual([]);
  });

  it('carries the one time token off the create response', async () => {
    post.mockResolvedValue({ data: { ...invite, token: 'tok-abc' } });

    const created = await createInvite('ws-mine', {
      email: 'someone@example.com',
      role: 'member',
    });

    expect(created.token).toBe('tok-abc');
    expect(post).toHaveBeenCalledWith(
      invitesPath('ws-mine'),
      { email: 'someone@example.com', role: 'member' },
      undefined
    );
  });

  it('revokes one invite', async () => {
    del.mockResolvedValue({ data: undefined });

    await revokeInvite('ws-mine', 'inv-1');

    expect(del).toHaveBeenCalledWith(
      `${invitesPath('ws-mine')}/inv-1`,
      undefined
    );
  });

  it('redeems a token against the accept route', async () => {
    post.mockResolvedValue({ data: member });

    await expect(acceptInvite('tok-abc')).resolves.toEqual(member);
    expect(post).toHaveBeenCalledWith(
      INVITE_ACCEPT_PATH,
      { token: 'tok-abc' },
      undefined
    );
  });
});
