/**
 * The planning contract the frontend depends on: `project_id` as a query
 * parameter on every single-entity route rather than a path segment, a cycle
 * whose status is read only, a milestone whose status is written, and a
 * roadmap that takes no project list. Each is pinned because a wrong path,
 * verb or parameter name type-checks identically and fails only against a live
 * backend.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendRoadmapEntries,
  createCycle,
  createMilestone,
  cyclePath,
  cyclesPath,
  deleteCycle,
  deleteMilestone,
  emptyRoadmapPage,
  getCycle,
  getMilestone,
  listCycles,
  listMilestones,
  listRoadmap,
  milestonePath,
  milestonesPath,
  roadmapPath,
  updateCycle,
  updateMilestone,
} from './planning';
import type {
  CycleRead,
  MilestoneRead,
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
const PROJECT = 'proj-1';

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
  project_id: PROJECT,
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

/** One milestone in exactly the shape the backend serialises. */
const milestone: MilestoneRead = {
  milestone_id: 'mil-1',
  workspace_id: WS,
  project_id: PROJECT,
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
  kind: 'milestone',
  id: 'mil-1',
  project_id: PROJECT,
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
  it('files cycles and milestones under the workspace', () => {
    expect(cyclesPath(WS)).toBe('/workspaces/ws-mine/cycles');
    expect(milestonesPath(WS)).toBe('/workspaces/ws-mine/projects');
    expect(roadmapPath(WS)).toBe('/workspaces/ws-mine/roadmap');
  });

  it('leaves the project out of a single entity path, so a link stays stable', () => {
    expect(cyclePath(WS, 'cyc-1')).toBe('/workspaces/ws-mine/cycles/cyc-1');
    expect(milestonePath(WS, 'mil-1')).toBe(
      '/workspaces/ws-mine/projects/mil-1'
    );
  });
});

describe('cycles', () => {
  it('lists under the project and returns the page', async () => {
    get.mockResolvedValue({
      data: { cycles: [cycle], next_cursor: 'next' },
    });

    const page = await listCycles(WS, { project_id: PROJECT });

    expect(get).toHaveBeenCalledWith(cyclesPath(WS), {
      query: { project_id: PROJECT },
    });
    expect(page.cycles).toEqual([cycle]);
    expect(page.next_cursor).toBe('next');
  });

  it('sends the status filter only when one is set', async () => {
    get.mockResolvedValue({ data: { cycles: [], next_cursor: null } });

    await listCycles(WS, { project_id: PROJECT, status: 'active' });

    expect(get).toHaveBeenCalledWith(cyclesPath(WS), {
      query: { project_id: PROJECT, status: 'active' },
    });
  });

  it('answers an empty page when the body carries no list', async () => {
    get.mockResolvedValue({ data: {} });

    const page = await listCycles(WS, { project_id: PROJECT });

    expect(page.cycles).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it('creates without sending a status, which the server derives', async () => {
    post.mockResolvedValue({ data: cycle });

    await createCycle(WS, {
      project_id: PROJECT,
      name: 'Sprint 1',
      start_date: '2026-09-01',
      end_date: '2026-09-14',
    });

    const body = post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(post.mock.calls[0]?.[0]).toBe(cyclesPath(WS));
    expect(body).not.toHaveProperty('status');
    expect(body['project_id']).toBe(PROJECT);
  });

  it('reads one cycle with the project as a query parameter', async () => {
    get.mockResolvedValue({ data: cycle });

    await getCycle(WS, 'cyc-1', PROJECT);

    expect(get).toHaveBeenCalledWith(cyclePath(WS, 'cyc-1'), {
      query: { project_id: PROJECT },
    });
  });

  it('patches through the project that names the row', async () => {
    patch.mockResolvedValue({ data: cycle });

    await updateCycle(WS, 'cyc-1', { project_id: PROJECT, cancelled: true });

    expect(patch).toHaveBeenCalledWith(
      cyclePath(WS, 'cyc-1'),
      { project_id: PROJECT, cancelled: true },
      undefined
    );
  });

  it('deletes with the project, since the row cannot be found without it', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteCycle(WS, 'cyc-1', PROJECT);

    expect(del).toHaveBeenCalledWith(cyclePath(WS, 'cyc-1'), {
      query: { project_id: PROJECT },
    });
  });
});

describe('milestones', () => {
  it('lists under the project and returns the page', async () => {
    get.mockResolvedValue({
      data: { milestones: [milestone], next_cursor: null },
    });

    const page = await listMilestones(WS, { project_id: PROJECT });

    expect(get).toHaveBeenCalledWith(milestonesPath(WS), {
      query: { project_id: PROJECT },
    });
    expect(page.milestones).toEqual([milestone]);
  });

  it('answers an empty page when the body carries no list', async () => {
    get.mockResolvedValue({ data: {} });

    const page = await listMilestones(WS, { project_id: PROJECT });

    expect(page.milestones).toEqual([]);
    expect(page.next_cursor).toBeNull();
  });

  it('creates with a status, which unlike a cycle is stored', async () => {
    post.mockResolvedValue({ data: milestone });

    await createMilestone(WS, {
      project_id: PROJECT,
      name: 'Public beta',
      status: 'in_progress',
    });

    expect(post).toHaveBeenCalledWith(
      milestonesPath(WS),
      { project_id: PROJECT, name: 'Public beta', status: 'in_progress' },
      undefined
    );
  });

  it('reads one milestone with the project as a query parameter', async () => {
    get.mockResolvedValue({ data: milestone });

    await getMilestone(WS, 'mil-1', PROJECT);

    expect(get).toHaveBeenCalledWith(milestonePath(WS, 'mil-1'), {
      query: { project_id: PROJECT },
    });
  });

  it('clears a target date by sending null rather than omitting it', async () => {
    patch.mockResolvedValue({ data: milestone });

    await updateMilestone(WS, 'mil-1', {
      project_id: PROJECT,
      target_date: null,
    });

    expect(patch).toHaveBeenCalledWith(
      milestonePath(WS, 'mil-1'),
      { project_id: PROJECT, target_date: null },
      undefined
    );
  });

  it('deletes with the project as a query parameter', async () => {
    del.mockResolvedValue({ data: undefined });

    await deleteMilestone(WS, 'mil-1', PROJECT);

    expect(del).toHaveBeenCalledWith(milestonePath(WS, 'mil-1'), {
      query: { project_id: PROJECT },
    });
  });
});

describe('roadmap', () => {
  it('reads with no filters at all, so the server decides the projects', async () => {
    get.mockResolvedValue({ data: { entries: [entry], next_cursor: null } });

    const page = await listRoadmap(WS);

    expect(get).toHaveBeenCalledWith(roadmapPath(WS), { query: {} });
    expect(page.entries).toEqual([entry]);
  });

  it('narrows by project and kind when they are set', async () => {
    get.mockResolvedValue({ data: { entries: [], next_cursor: null } });

    await listRoadmap(WS, { project_id: PROJECT, kind: 'cycle', limit: 50 });

    expect(get).toHaveBeenCalledWith(roadmapPath(WS), {
      query: { project_id: PROJECT, kind: 'cycle', limit: 50 },
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

  it('keeps a cycle and a milestone that happen to share an id', () => {
    const twin: RoadmapEntryRead = { ...entry, kind: 'cycle' };

    expect(appendRoadmapEntries([entry], [twin])).toEqual([entry, twin]);
  });

  it('appends the entries a later page actually adds', () => {
    const later: RoadmapEntryRead = { ...entry, id: 'mil-2' };

    expect(appendRoadmapEntries([entry], [entry, later])).toEqual([
      entry,
      later,
    ]);
  });
});
