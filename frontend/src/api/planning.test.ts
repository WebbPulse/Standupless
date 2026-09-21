/**
 * The planning contract the frontend depends on: `team_id` as a query
 * parameter on every single-entity route rather than a path segment, a cycle
 * whose status is read only, a project whose status is written, and a
 * roadmap that takes no team list. Each is pinned because a wrong path,
 * verb or parameter name type-checks identically and fails only against a live
 * backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRoadmapEntries,
  createCycle,
  createProject,
  cyclePath,
  cyclesPath,
  deleteCycle,
  deleteProject,
  emptyRoadmapPage,
  getCycle,
  getProject,
  listCycles,
  listProjects,
  listRoadmap,
  projectPath,
  projectsPath,
  roadmapPath,
  updateCycle,
  updateProject,
} from './planning';
import type {
  CycleRead,
  ProjectRead,
  RoadmapEntryRead,
  RollupCounts,
} from '../types/Api';

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

const WS = 'ws-mine';
const TEAM = 'proj-1';

/** The counts a planning row carries, in the shape the backend serialises. */
const counts: RollupCounts = {
  todo: 2,
  in_progress: 1,
  done: 3,
  cancelled: 0,
  total: 6,
};

/** One cycle in exactly the shape the backend serialises. */
const cycle: CycleRead = {
  cycle_id: 'cyc-1',
  workspace_id: WS,
  team_id: TEAM,
  name: 'Sprint 1',
  start_date: '2026-09-01',
  end_date: '2026-09-14',
  goal: 'Ship the engine',
  cancelled: false,
  status: 'completed',
  counts,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** One project in exactly the shape the backend serialises. */
const project: ProjectRead = {
  project_id: 'prj-1',
  workspace_id: WS,
  team_id: TEAM,
  name: 'Public beta',
  description: null,
  target_date: '2026-10-01',
  status: 'in_progress',
  counts,
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

/** One roadmap entry in exactly the shape the backend serialises. */
const entry: RoadmapEntryRead = {
  kind: 'project',
  id: 'prj-1',
  team_id: TEAM,
  name: 'Public beta',
  target_date: '2026-10-01',
  start_date: null,
  status: 'in_progress',
  counts,
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('route shapes', () => {
  it('files cycles and projects under the workspace', () => {
    expect(cyclesPath(WS)).toBe('/workspaces/ws-mine/cycles');
    expect(projectsPath(WS)).toBe('/workspaces/ws-mine/projects');
    expect(roadmapPath(WS)).toBe('/workspaces/ws-mine/roadmap');
  });

  it('leaves the team out of a single entity path, so a link stays stable', () => {
    expect(cyclePath(WS, 'cyc-1')).toBe('/workspaces/ws-mine/cycles/cyc-1');
    expect(projectPath(WS, 'prj-1')).toBe('/workspaces/ws-mine/projects/prj-1');
  });
});

describe('cycles', () => {
  it('lists under the team and returns the page', async () => {
    get.mockResolvedValue({
      data: { cycles: [cycle], next_cursor: 'next' },
    });

    const page = await listCycles(WS, { team_id: TEAM });

    expect(get).toHaveBeenCalledWith(cyclesPath(WS), {
      query: { team_id: TEAM },
    });
    expect(page.cycles).toEqual([cycle]);
    expect(page.next_cursor).toBe('next');
  });

  it('sends the status filter only when one is set', async () => {
    get.mockResolvedValue({ data: { cycles: [], next_cursor: null } });

    await listCycles(WS, { team_id: TEAM, status: 'active' });

    expect(get).toHaveBeenCalledWith(cyclesPath(WS), {
      query: { team_id: TEAM, status: 'active' },
    });
  });

  it('answers an empty page when the body carries no list', async () => {
    get.mockResolvedValue({ data: {} });

    const page = await listCycles(WS, { team_id: TEAM });

    expect(page.cycles).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it('creates without sending a status, which the server derives', async () => {
    post.mockResolvedValue({ data: cycle });

    await createCycle(WS, {
      team_id: TEAM,
      name: 'Sprint 1',
      start_date: '2026-09-01',
      end_date: '2026-09-14',
    });

    const body = post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(post.mock.calls[0]?.[0]).toBe(cyclesPath(WS));
    expect(body).not.toHaveProperty('status');
    expect(body['team_id']).toBe(TEAM);
  });

  it('reads one cycle with the team as a query parameter', async () => {
    get.mockResolvedValue({ data: cycle });

    await getCycle(WS, 'cyc-1', TEAM);

    expect(get).toHaveBeenCalledWith(cyclePath(WS, 'cyc-1'), {
      query: { team_id: TEAM },
    });
  });

  it('patches through the team that names the row', async () => {
    patch.mockResolvedValue({ data: cycle });

    await updateCycle(WS, 'cyc-1', { team_id: TEAM, cancelled: true });

    expect(patch).toHaveBeenCalledWith(
      cyclePath(WS, 'cyc-1'),
      { team_id: TEAM, cancelled: true },
      undefined
    );
  });

  it('deletes with the team, since the row cannot be found without it', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteCycle(WS, 'cyc-1', TEAM);

    expect(del).toHaveBeenCalledWith(cyclePath(WS, 'cyc-1'), {
      query: { team_id: TEAM },
    });
  });
});

describe('projects', () => {
  it('lists under the team and returns the page', async () => {
    get.mockResolvedValue({
      data: { projects: [project], next_cursor: null },
    });

    const page = await listProjects(WS, { team_id: TEAM });

    expect(get).toHaveBeenCalledWith(projectsPath(WS), {
      query: { team_id: TEAM },
    });
    expect(page.projects).toEqual([project]);
  });

  it('answers an empty page when the body carries no list', async () => {
    get.mockResolvedValue({ data: {} });

    const page = await listProjects(WS, { team_id: TEAM });

    expect(page.projects).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it('creates with a status, which unlike a cycle is stored', async () => {
    post.mockResolvedValue({ data: project });

    await createProject(WS, {
      team_id: TEAM,
      name: 'Public beta',
      status: 'in_progress',
    });

    expect(post).toHaveBeenCalledWith(
      projectsPath(WS),
      { team_id: TEAM, name: 'Public beta', status: 'in_progress' },
      undefined
    );
  });

  it('reads one project with the team as a query parameter', async () => {
    get.mockResolvedValue({ data: project });

    await getProject(WS, 'prj-1', TEAM);

    expect(get).toHaveBeenCalledWith(projectPath(WS, 'prj-1'), {
      query: { team_id: TEAM },
    });
  });

  it('clears a target date by sending null rather than omitting it', async () => {
    patch.mockResolvedValue({ data: project });

    await updateProject(WS, 'prj-1', {
      team_id: TEAM,
      target_date: null,
    });

    expect(patch).toHaveBeenCalledWith(
      projectPath(WS, 'prj-1'),
      { team_id: TEAM, target_date: null },
      undefined
    );
  });

  it('deletes with the team as a query parameter', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteProject(WS, 'prj-1', TEAM);

    expect(del).toHaveBeenCalledWith(projectPath(WS, 'prj-1'), {
      query: { team_id: TEAM },
    });
  });
});

describe('roadmap', () => {
  it('reads with no filters at all, so the server decides the teams', async () => {
    get.mockResolvedValue({ data: { entries: [entry], next_cursor: null } });

    const page = await listRoadmap(WS);

    expect(get).toHaveBeenCalledWith(roadmapPath(WS), { query: {} });
    expect(page.entries).toEqual([entry]);
  });

  it('narrows by team and kind when they are set', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });

    await listRoadmap(WS, { team_id: TEAM, kind: 'cycle', limit: 50 });

    expect(get).toHaveBeenCalledWith(roadmapPath(WS), {
      query: { team_id: TEAM, kind: 'cycle', limit: 50 },
    });
  });

  it('carries the cursor through to the next page', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });

    await listRoadmap(WS, { cursor: 'opaque' });

    expect(get).toHaveBeenCalledWith(roadmapPath(WS), {
      query: { cursor: 'opaque' },
    });
  });

  it('answers an empty page when the body carries no list', async () => {
    get.mockResolvedValue({ data: {} });

    const page = await listRoadmap(WS);

    expect(page.entries).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it('offers an empty page for a read that has not run', () => {
    expect(emptyRoadmapPage()).toEqual({ entries: [], next_cursor: null });
  });
});

describe('appending roadmap pages', () => {
  it('drops an entry a merged cursor repeated', () => {
    expect(appendRoadmapEntries([entry], [entry])).toEqual([entry]);
  });

  it('keeps a cycle and a project that happen to share an id', () => {
    const twin: RoadmapEntryRead = { ...entry, kind: 'cycle' };

    expect(appendRoadmapEntries([entry], [twin])).toEqual([entry, twin]);
  });

  it('appends the entries a later page actually adds', () => {
    const later: RoadmapEntryRead = { ...entry, id: 'prj-2' };

    expect(appendRoadmapEntries([entry], [entry, later])).toEqual([
      entry,
      later,
    ]);
  });
});
