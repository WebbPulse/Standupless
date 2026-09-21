/**
 * The planning routes: a project's cycles and milestones, and the workspace
 * roadmap that reads across both. Every single-entity route carries
 * `project_id` as a query parameter rather than a path segment, because the
 * planning table's sort key is filed under the project and a read without it
 * would be a scan; keeping it out of the path leaves a cycle id stable in a
 * permalink, exactly as the discussion routes do for an issue id.
 */

import apiClient from './client';
import type {
  CycleCreate,
  CycleListQuery,
  CycleListRead,
  CycleRead,
  CycleUpdate,
  MilestoneCreate,
  MilestoneListQuery,
  MilestoneListRead,
  MilestoneRead,
  MilestoneUpdate,
  RoadmapEntryRead,
  RoadmapListRead,
  RoadmapQuery,
} from '../types/Api';

/** The route cycles are listed and created on. */
export const cyclesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/cycles`;

/** The route one cycle is read, edited and deleted through. */
export const cyclePath = (workspaceId: string, cycleId: string): string =>
  `${cyclesPath(workspaceId)}/${cycleId}`;

/** The route milestones are listed and created on. */
export const milestonesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/projects`;

/** The route one milestone is read, edited and deleted through. */
export const milestonePath = (
  workspaceId: string,
  milestoneId: string
): string => `${milestonesPath(workspaceId)}/${milestoneId}`;

/** The route the roadmap is read from. */
export const roadmapPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/roadmap`;

type QueryBag = Record<string, string | number | boolean | undefined>;

const listOptions = (
  query: QueryBag,
  signal?: AbortSignal
): { query: QueryBag; signal?: AbortSignal } =>
  signal === undefined ? { query } : { query, signal };

/**
 * Lists one project's cycles by start date ascending. The project is required
 * rather than optional: the list is a query under the project's own prefix, so
 * there is no workspace wide cycle read, and the roadmap is what answers the
 * cross-project question.
 */
export const listCycles = async (
  workspaceId: string,
  query: CycleListQuery,
  signal?: AbortSignal
): Promise<CycleListRead> => {
  const response = await apiClient.get<CycleListRead>(
    cyclesPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    cycles: Array.isArray(body?.cycles) ? body.cycles : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Creates a cycle. `status` is derived from the dates on every read, so it is
 * absent from the body and there is nothing here to keep in step with them.
 */
export const createCycle = async (
  workspaceId: string,
  body: CycleCreate
): Promise<CycleRead> => {
  const response = await apiClient.post<CycleRead>(
    cyclesPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one cycle. */
export const getCycle = async (
  workspaceId: string,
  cycleId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<CycleRead> => {
  const response = await apiClient.get<CycleRead>(
    cyclePath(workspaceId, cycleId),
    listOptions({ project_id: projectId }, signal)
  );
  return response.data;
};

/**
 * Edits a cycle. The project is sent on every patch because it names the row
 * rather than being a field of it, and a cycle never moves between projects.
 */
export const updateCycle = async (
  workspaceId: string,
  cycleId: string,
  body: CycleUpdate
): Promise<CycleRead> => {
  const response = await apiClient.patch<CycleRead>(
    cyclePath(workspaceId, cycleId),
    body
  );
  return response.data;
};

/**
 * Deletes a cycle. Issues pointing at it keep their `cycle_id` until they are
 * next patched, and the pointer simply stops resolving.
 */
export const deleteCycle = async (
  workspaceId: string,
  cycleId: string,
  projectId: string
): Promise<void> => {
  await apiClient.delete<void>(cyclePath(workspaceId, cycleId), {
    query: { project_id: projectId },
  });
};

/**
 * Lists one project's milestones by target date ascending, undated last. The
 * project is required for the same reason a cycle list's is.
 */
export const listMilestones = async (
  workspaceId: string,
  query: MilestoneListQuery,
  signal?: AbortSignal
): Promise<MilestoneListRead> => {
  const response = await apiClient.get<MilestoneListRead>(
    milestonesPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    milestones: Array.isArray(body?.milestones) ? body.milestones : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Creates a milestone. Unlike a cycle its `status` is stored, because a target
 * date alone cannot say whether the work has begun.
 */
export const createMilestone = async (
  workspaceId: string,
  body: MilestoneCreate
): Promise<MilestoneRead> => {
  const response = await apiClient.post<MilestoneRead>(
    milestonesPath(workspaceId),
    body
  );
  return response.data;
};

/** Reads one milestone. */
export const getMilestone = async (
  workspaceId: string,
  milestoneId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<MilestoneRead> => {
  const response = await apiClient.get<MilestoneRead>(
    milestonePath(workspaceId, milestoneId),
    listOptions({ project_id: projectId }, signal)
  );
  return response.data;
};

/** Edits a milestone. A null `target_date` clears it and leaves it undated. */
export const updateMilestone = async (
  workspaceId: string,
  milestoneId: string,
  body: MilestoneUpdate
): Promise<MilestoneRead> => {
  const response = await apiClient.patch<MilestoneRead>(
    milestonePath(workspaceId, milestoneId),
    body
  );
  return response.data;
};

/** Deletes a milestone. */
export const deleteMilestone = async (
  workspaceId: string,
  milestoneId: string,
  projectId: string
): Promise<void> => {
  await apiClient.delete<void>(milestonePath(workspaceId, milestoneId), {
    query: { project_id: projectId },
  });
};

/**
 * Reads the roadmap across every project the caller can see, by date ascending
 * with the undated entries last. There is no project list parameter: the
 * server fans out over exactly the projects the caller's own context allows,
 * so a wider read is not something a caller can ask for.
 */
export const listRoadmap = async (
  workspaceId: string,
  query: RoadmapQuery = {},
  signal?: AbortSignal
): Promise<RoadmapListRead> => {
  const response = await apiClient.get<RoadmapListRead>(
    roadmapPath(workspaceId),
    listOptions({ ...query }, signal)
  );
  const body = response.data;
  return {
    entries: Array.isArray(body?.entries) ? body.entries : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/** An empty roadmap page, for a query disabled before its ids are known. */
export const emptyRoadmapPage = (): RoadmapListRead => ({
  entries: [],
  next_cursor: null,
});

/**
 * Appends a cursor page of roadmap entries, dropping a repeated row. A merged
 * cursor can repeat an entry when a write lands between two pages, and the key
 * has to fold the kind in because a cycle and a milestone may share an id
 * space only by accident of both being ULIDs.
 */
export const appendRoadmapEntries = (
  held: RoadmapEntryRead[],
  incoming: RoadmapEntryRead[]
): RoadmapEntryRead[] => {
  const seen = new Set(held.map((row) => `${row.kind}:${row.id}`));
  return [
    ...held,
    ...incoming.filter((row) => !seen.has(`${row.kind}:${row.id}`)),
  ];
};
