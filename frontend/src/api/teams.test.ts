/**
 * The team, status and label contract the frontend depends on: every path is
 * workspace scoped, every list answers a plural envelope, and the team member
 * grant is a PUT rather than a POST. Each is pinned because a wrong path or verb
 * type-checks identically and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLabel,
  createTeam,
  createStatus,
  deleteLabel,
  deleteTeam,
  deleteStatus,
  getTeam,
  joinTeam,
  labelsPath,
  leaveTeam,
  listLabels,
  listTeamMembers,
  listTeams,
  listStatuses,
  teamMembersPath,
  teamPath,
  teamsPath,
  removeTeamMember,
  setTeamMember,
  statusesPath,
  updateLabel,
  updateTeam,
  updateStatus,
} from './teams';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const put =
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
    put: (path: string, body?: unknown, options?: unknown) =>
      put(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const WS = 'ws-mine';
const TEAM = 'proj-1';

/** One team row in exactly the shape the backend serialises. */
const team = {
  id: TEAM,
  workspace_id: WS,
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
  member_count: 3,
  is_member: true,
  retired_key_prefixes: [],
};

/** One status row in exactly the shape the backend serialises. */
const status = {
  id: 'st-1',
  name: 'Todo',
  category: 'unstarted',
  position: 1,
};

/** One label row in exactly the shape the backend serialises. */
const label = { id: 'lb-1', name: 'bug', color: '#ef4444' };

/** One team member row in exactly the shape the backend serialises. */
const teamMember = {
  user_id: 'user-1',
  email: 'someone@example.com',
  display_name: 'Someone',
  role: 'member',
  added_at: '2026-09-17T00:00:00Z',
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('the paths', () => {
  it('scopes every team path to its workspace', () => {
    expect(teamsPath(WS)).toBe('/workspaces/ws-mine/teams');
    expect(teamPath(WS, TEAM)).toBe('/workspaces/ws-mine/teams/proj-1');
    expect(statusesPath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/proj-1/statuses'
    );
    expect(labelsPath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/proj-1/labels'
    );
    expect(teamMembersPath(WS, TEAM)).toBe(
      '/workspaces/ws-mine/teams/proj-1/members'
    );
  });
});

describe('the team routes', () => {
  it('reads the teams out of the envelope', async () => {
    get.mockResolvedValue({ data: { teams: [team] } });

    await expect(listTeams(WS)).resolves.toEqual([team]);
    expect(get).toHaveBeenCalledWith(teamsPath(WS), undefined);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listTeams(WS)).resolves.toEqual([]);
  });

  it('passes an abort signal through when one is given', async () => {
    get.mockResolvedValue({ data: { teams: [] } });
    const controller = new AbortController();

    await listTeams(WS, controller.signal);

    expect(get).toHaveBeenCalledWith(teamsPath(WS), {
      signal: controller.signal,
    });
  });

  it('posts the name, key prefix and estimate scale', async () => {
    post.mockResolvedValue({ data: team });

    await createTeam(WS, {
      name: 'Engine',
      key_prefix: 'ENG',
      estimate_scale: 'fibonacci',
    });

    expect(post).toHaveBeenCalledWith(
      teamsPath(WS),
      { name: 'Engine', key_prefix: 'ENG', estimate_scale: 'fibonacci' },
      undefined
    );
  });

  it('posts a description on create, so no follow-up patch is needed', async () => {
    post.mockResolvedValue({ data: team });

    await createTeam(WS, {
      name: 'Engine',
      key_prefix: 'ENG',
      description: 'Build systems',
    });

    expect(post).toHaveBeenCalledWith(
      teamsPath(WS),
      { name: 'Engine', key_prefix: 'ENG', description: 'Build systems' },
      undefined
    );
  });

  it('patches a new key prefix and reads back the retired one', async () => {
    patch.mockResolvedValue({
      data: { ...team, key_prefix: 'ENX', retired_key_prefixes: ['ENG'] },
    });

    const updated = await updateTeam(WS, TEAM, { key_prefix: 'ENX' });

    expect(patch).toHaveBeenCalledWith(
      teamPath(WS, TEAM),
      { key_prefix: 'ENX' },
      undefined
    );
    expect(updated.retired_key_prefixes).toEqual(['ENG']);
  });

  it('carries the member count and membership on a listed team', async () => {
    get.mockResolvedValue({ data: { teams: [team] } });

    const [row] = await listTeams(WS);

    expect(row?.member_count).toBe(3);
    expect(row?.is_member).toBe(true);
  });

  it('rejects when the API refuses a duplicate key prefix', async () => {
    post.mockRejectedValue(new Error('key prefix taken'));

    await expect(
      createTeam(WS, { name: 'Engine', key_prefix: 'ENG' })
    ).rejects.toThrow('key prefix taken');
  });

  it('reads, patches and deletes one team', async () => {
    get.mockResolvedValue({ data: team });
    patch.mockResolvedValue({ data: team });
    del.mockResolvedValue({ data: undefined });

    await getTeam(WS, TEAM);
    await updateTeam(WS, TEAM, { name: 'Renamed' });
    await deleteTeam(WS, TEAM);

    expect(get).toHaveBeenCalledWith(teamPath(WS, TEAM), undefined);
    expect(patch).toHaveBeenCalledWith(
      teamPath(WS, TEAM),
      { name: 'Renamed' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(teamPath(WS, TEAM), undefined);
  });
});

describe('the team member routes', () => {
  it('reads the members out of the envelope', async () => {
    get.mockResolvedValue({ data: { members: [teamMember] } });

    await expect(listTeamMembers(WS, TEAM)).resolves.toEqual([teamMember]);
  });

  it('grants a role with a PUT, since the contract makes it an upsert', async () => {
    put.mockResolvedValue({ data: teamMember });

    await setTeamMember(WS, TEAM, 'user-1', { role: 'admin' });

    expect(put).toHaveBeenCalledWith(
      `${teamMembersPath(WS, TEAM)}/user-1`,
      { role: 'admin' },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('joins a team with a POST on the team path', async () => {
    post.mockResolvedValue({ data: teamMember });

    await expect(joinTeam(WS, TEAM)).resolves.toEqual(teamMember);

    expect(post).toHaveBeenCalledWith(
      `${teamPath(WS, TEAM)}/join`,
      undefined,
      undefined
    );
  });

  it('leaves a team, surfacing the 409 for the last admin', async () => {
    post.mockResolvedValueOnce({ data: undefined });
    await leaveTeam(WS, TEAM);
    expect(post).toHaveBeenCalledWith(
      `${teamPath(WS, TEAM)}/leave`,
      undefined,
      undefined
    );

    post.mockRejectedValueOnce(new Error('last team admin'));
    await expect(leaveTeam(WS, TEAM)).rejects.toThrow('last team admin');
  });

  it('removes one team member', async () => {
    del.mockResolvedValue({ data: undefined });

    await removeTeamMember(WS, TEAM, 'user-1');

    expect(del).toHaveBeenCalledWith(
      `${teamMembersPath(WS, TEAM)}/user-1`,
      undefined
    );
  });
});

describe('the status routes', () => {
  it('reads the statuses out of the envelope', async () => {
    get.mockResolvedValue({ data: { statuses: [status] } });

    await expect(listStatuses(WS, TEAM)).resolves.toEqual([status]);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listStatuses(WS, TEAM)).resolves.toEqual([]);
  });

  it('posts a new status with its category and position', async () => {
    post.mockResolvedValue({ data: status });

    await createStatus(WS, TEAM, {
      name: 'Todo',
      category: 'unstarted',
      position: 1,
    });

    expect(post).toHaveBeenCalledWith(
      statusesPath(WS, TEAM),
      { name: 'Todo', category: 'unstarted', position: 1 },
      undefined
    );
  });

  it('patches a position on its own, which is how a reorder is expressed', async () => {
    patch.mockResolvedValue({ data: status });

    await updateStatus(WS, TEAM, 'st-1', { position: 3 });

    expect(patch).toHaveBeenCalledWith(
      `${statusesPath(WS, TEAM)}/st-1`,
      { position: 3 },
      undefined
    );
  });

  it('surfaces the 409 when the last status of a category is deleted', async () => {
    del.mockRejectedValue(new Error('last status in category'));

    await expect(deleteStatus(WS, TEAM, 'st-1')).rejects.toThrow(
      'last status in category'
    );
  });
});

describe('the label routes', () => {
  it('reads the labels out of the envelope', async () => {
    get.mockResolvedValue({ data: { labels: [label] } });

    await expect(listLabels(WS, TEAM)).resolves.toEqual([label]);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listLabels(WS, TEAM)).resolves.toEqual([]);
  });

  it('posts a new label with its colour', async () => {
    post.mockResolvedValue({ data: label });

    await createLabel(WS, TEAM, { name: 'bug', color: '#ef4444' });

    expect(post).toHaveBeenCalledWith(
      labelsPath(WS, TEAM),
      { name: 'bug', color: '#ef4444' },
      undefined
    );
  });

  it('patches and deletes one label', async () => {
    patch.mockResolvedValue({ data: label });
    del.mockResolvedValue({ data: undefined });

    await updateLabel(WS, TEAM, 'lb-1', { color: '#22c55e' });
    await deleteLabel(WS, TEAM, 'lb-1');

    expect(patch).toHaveBeenCalledWith(
      `${labelsPath(WS, TEAM)}/lb-1`,
      { color: '#22c55e' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(`${labelsPath(WS, TEAM)}/lb-1`, undefined);
  });
});
