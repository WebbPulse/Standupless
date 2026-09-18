/**
 * The project, status and label contract the frontend depends on: every path is
 * workspace scoped, every list answers a plural envelope, and the project member
 * grant is a PUT rather than a POST. Each is pinned because a wrong path or verb
 * type-checks identically and fails only against a live backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLabel,
  createProject,
  createStatus,
  deleteLabel,
  deleteProject,
  deleteStatus,
  getProject,
  labelsPath,
  listLabels,
  listProjectMembers,
  listProjects,
  listStatuses,
  projectMembersPath,
  projectPath,
  projectsPath,
  removeProjectMember,
  setProjectMember,
  statusesPath,
  updateLabel,
  updateProject,
  updateStatus,
} from './projects';

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
const PROJECT = 'proj-1';

/** One project row in exactly the shape the backend serialises. */
const project = {
  id: PROJECT,
  workspace_id: WS,
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
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

/** One project member row in exactly the shape the backend serialises. */
const projectMember = {
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
  it('scopes every project path to its workspace', () => {
    expect(projectsPath(WS)).toBe('/workspaces/ws-mine/projects');
    expect(projectPath(WS, PROJECT)).toBe(
      '/workspaces/ws-mine/projects/proj-1'
    );
    expect(statusesPath(WS, PROJECT)).toBe(
      '/workspaces/ws-mine/projects/proj-1/statuses'
    );
    expect(labelsPath(WS, PROJECT)).toBe(
      '/workspaces/ws-mine/projects/proj-1/labels'
    );
    expect(projectMembersPath(WS, PROJECT)).toBe(
      '/workspaces/ws-mine/projects/proj-1/members'
    );
  });
});

describe('the project routes', () => {
  it('reads the projects out of the envelope', async () => {
    get.mockResolvedValue({ data: { projects: [project] } });

    await expect(listProjects(WS)).resolves.toEqual([project]);
    expect(get).toHaveBeenCalledWith(projectsPath(WS), undefined);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listProjects(WS)).resolves.toEqual([]);
  });

  it('passes an abort signal through when one is given', async () => {
    get.mockResolvedValue({ data: { projects: [] } });
    const controller = new AbortController();

    await listProjects(WS, controller.signal);

    expect(get).toHaveBeenCalledWith(projectsPath(WS), {
      signal: controller.signal,
    });
  });

  it('posts the name, key prefix and estimate scale', async () => {
    post.mockResolvedValue({ data: project });

    await createProject(WS, {
      name: 'Engine',
      key_prefix: 'ENG',
      estimate_scale: 'fibonacci',
    });

    expect(post).toHaveBeenCalledWith(
      projectsPath(WS),
      { name: 'Engine', key_prefix: 'ENG', estimate_scale: 'fibonacci' },
      undefined
    );
  });

  it('rejects when the API refuses a duplicate key prefix', async () => {
    post.mockRejectedValue(new Error('key prefix taken'));

    await expect(
      createProject(WS, { name: 'Engine', key_prefix: 'ENG' })
    ).rejects.toThrow('key prefix taken');
  });

  it('reads, patches and deletes one project', async () => {
    get.mockResolvedValue({ data: project });
    patch.mockResolvedValue({ data: project });
    del.mockResolvedValue({ data: undefined });

    await getProject(WS, PROJECT);
    await updateProject(WS, PROJECT, { name: 'Renamed' });
    await deleteProject(WS, PROJECT);

    expect(get).toHaveBeenCalledWith(projectPath(WS, PROJECT), undefined);
    expect(patch).toHaveBeenCalledWith(
      projectPath(WS, PROJECT),
      { name: 'Renamed' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(projectPath(WS, PROJECT), undefined);
  });
});

describe('the project member routes', () => {
  it('reads the members out of the envelope', async () => {
    get.mockResolvedValue({ data: { members: [projectMember] } });

    await expect(listProjectMembers(WS, PROJECT)).resolves.toEqual([
      projectMember,
    ]);
  });

  it('grants a role with a PUT, since the contract makes it an upsert', async () => {
    put.mockResolvedValue({ data: projectMember });

    await setProjectMember(WS, PROJECT, 'user-1', { role: 'admin' });

    expect(put).toHaveBeenCalledWith(
      `${projectMembersPath(WS, PROJECT)}/user-1`,
      { role: 'admin' },
      undefined
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('removes one project member', async () => {
    del.mockResolvedValue({ data: undefined });

    await removeProjectMember(WS, PROJECT, 'user-1');

    expect(del).toHaveBeenCalledWith(
      `${projectMembersPath(WS, PROJECT)}/user-1`,
      undefined
    );
  });
});

describe('the status routes', () => {
  it('reads the statuses out of the envelope', async () => {
    get.mockResolvedValue({ data: { statuses: [status] } });

    await expect(listStatuses(WS, PROJECT)).resolves.toEqual([status]);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listStatuses(WS, PROJECT)).resolves.toEqual([]);
  });

  it('posts a new status with its category and position', async () => {
    post.mockResolvedValue({ data: status });

    await createStatus(WS, PROJECT, {
      name: 'Todo',
      category: 'unstarted',
      position: 1,
    });

    expect(post).toHaveBeenCalledWith(
      statusesPath(WS, PROJECT),
      { name: 'Todo', category: 'unstarted', position: 1 },
      undefined
    );
  });

  it('patches a position on its own, which is how a reorder is expressed', async () => {
    patch.mockResolvedValue({ data: status });

    await updateStatus(WS, PROJECT, 'st-1', { position: 3 });

    expect(patch).toHaveBeenCalledWith(
      `${statusesPath(WS, PROJECT)}/st-1`,
      { position: 3 },
      undefined
    );
  });

  it('surfaces the 409 when the last status of a category is deleted', async () => {
    del.mockRejectedValue(new Error('last status in category'));

    await expect(deleteStatus(WS, PROJECT, 'st-1')).rejects.toThrow(
      'last status in category'
    );
  });
});

describe('the label routes', () => {
  it('reads the labels out of the envelope', async () => {
    get.mockResolvedValue({ data: { labels: [label] } });

    await expect(listLabels(WS, PROJECT)).resolves.toEqual([label]);
  });

  it('answers an empty list when the body carries no array', async () => {
    get.mockResolvedValue({ data: {} });

    await expect(listLabels(WS, PROJECT)).resolves.toEqual([]);
  });

  it('posts a new label with its colour', async () => {
    post.mockResolvedValue({ data: label });

    await createLabel(WS, PROJECT, { name: 'bug', color: '#ef4444' });

    expect(post).toHaveBeenCalledWith(
      labelsPath(WS, PROJECT),
      { name: 'bug', color: '#ef4444' },
      undefined
    );
  });

  it('patches and deletes one label', async () => {
    patch.mockResolvedValue({ data: label });
    del.mockResolvedValue({ data: undefined });

    await updateLabel(WS, PROJECT, 'lb-1', { color: '#22c55e' });
    await deleteLabel(WS, PROJECT, 'lb-1');

    expect(patch).toHaveBeenCalledWith(
      `${labelsPath(WS, PROJECT)}/lb-1`,
      { color: '#22c55e' },
      undefined
    );
    expect(del).toHaveBeenCalledWith(
      `${labelsPath(WS, PROJECT)}/lb-1`,
      undefined
    );
  });
});
