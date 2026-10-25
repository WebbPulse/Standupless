/**
 * The workspace's project statuses as the interface reads them. Each status
 * sits in one of the six fixed categories every rule keys off, and the six
 * seeded defaults carry their category as their id, so a project saved before
 * custom statuses resolves to its category's default without a migration.
 */

import { PROJECT_STATUSES, PROJECT_STATUS_LABELS } from './planningDisplay';
import { PROJECT_STATUS_ORDER } from './planningModel';
import type { ProjectStatus, ProjectStatusRead } from '../types/Api';

/** The six seeded statuses, one per category, read before the list arrives. */
export const DEFAULT_PROJECT_STATUSES: ProjectStatusRead[] =
  PROJECT_STATUSES.map((category) => ({
    id: category,
    name: PROJECT_STATUS_LABELS[category],
    category,
    color: null,
    description: null,
    position: 0,
    is_default: true,
    project_count: 0,
    created_at: '',
    updated_at: '',
  }));

/** The fields a project status is resolved from. */
export interface HasProjectStatus {
  status: ProjectStatus;
  status_id?: string | null | undefined;
}

/** Whether a value is one of the six categories. */
export const isProjectStatusCategory = (
  value: string
): value is ProjectStatus =>
  (PROJECT_STATUSES as readonly string[]).includes(value);

/** The category's default status: the first of the category, or its seeded one. */
export const defaultStatusFor = (
  statuses: readonly ProjectStatusRead[],
  category: ProjectStatus
): ProjectStatusRead =>
  statuses.find((row) => row.category === category && row.is_default) ??
  statuses.find(
    (row) => row.category === category && (row.team_id ?? null) === null
  ) ??
  DEFAULT_PROJECT_STATUSES.find((row) => row.category === category) ??
  (DEFAULT_PROJECT_STATUSES[0] as ProjectStatusRead);

/**
 * The status a project sits in: its status id when the workspace still has it,
 * otherwise its category's default.
 */
export const projectStatusOf = (
  project: HasProjectStatus,
  statuses: readonly ProjectStatusRead[]
): ProjectStatusRead => {
  const id = project.status_id ?? project.status;
  const found = statuses.find((row) => row.id === id);
  return found !== undefined && found.category === project.status
    ? found
    : defaultStatusFor(statuses, project.status);
};

/** A status by id, or the default of a category named in its place. */
export const findProjectStatus = (
  statuses: readonly ProjectStatusRead[],
  id: string
): ProjectStatusRead | undefined =>
  statuses.find((row) => row.id === id) ??
  (isProjectStatusCategory(id) ? defaultStatusFor(statuses, id) : undefined);

/**
 * The statuses by category in the given order. Within a category the
 * workspace's come first by position, then each team's own by position, as a
 * team numbers its statuses apart from the workspace's.
 */
export const orderProjectStatuses = (
  statuses: readonly ProjectStatusRead[],
  order: readonly ProjectStatus[] = PROJECT_STATUSES
): ProjectStatusRead[] =>
  order.flatMap((category) =>
    statuses
      .filter((row) => row.category === category)
      .sort((left, right) => {
        const leftTeam = left.team_id ?? '';
        const rightTeam = right.team_id ?? '';
        if (leftTeam !== rightTeam) return leftTeam < rightTeam ? -1 : 1;
        return left.position - right.position;
      })
  );

/** The statuses in the order the projects list groups and offers them. */
export const listOrderedProjectStatuses = (
  statuses: readonly ProjectStatusRead[]
): ProjectStatusRead[] => orderProjectStatuses(statuses, PROJECT_STATUS_ORDER);

/** The body fields that move a project onto a status. */
export const statusPatch = (
  status: ProjectStatusRead
): { status: ProjectStatus; status_id: string } => ({
  status: status.category,
  status_id: status.id,
});

/**
 * Whether a project passes a status filter value: a status id keeps that
 * status, a seeded one too, and a category no status carries as its id, such
 * as one whose seeded status was deleted, keeps the whole category.
 */
export const matchesStatusValue = (
  project: HasProjectStatus,
  value: string,
  statuses: readonly ProjectStatusRead[]
): boolean => {
  if (statuses.some((row) => row.id === value)) {
    return projectStatusOf(project, statuses).id === value;
  }
  return isProjectStatusCategory(value) && project.status === value;
};

/** Whether a project passes a status filter, which keeps every project when empty. */
export const matchesStatusFilter = (
  project: HasProjectStatus,
  values: readonly string[],
  statuses: readonly ProjectStatusRead[]
): boolean =>
  values.length === 0 ||
  values.some((value) => matchesStatusValue(project, value, statuses));
