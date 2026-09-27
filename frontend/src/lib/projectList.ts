/**
 * How the projects list orders and groups its rows. Kept apart from the page
 * so the choices can be tested against fixed rows, and so the roadmap can
 * group its lanes the same way.
 */

import { completionPercent, PROJECT_STATUS_LABELS } from './planningDisplay';
import { PROJECT_STATUS_ORDER } from './planningModel';
import { personLabel, type Assignable } from './issuePeople';
import type { ProjectRead, TeamRead } from '../types/Api';

/** What the projects list can order by. */
export type ProjectOrdering =
  'target' | 'start' | 'name' | 'progress' | 'created' | 'updated';

/** The orderings in the order the display menu offers them. */
export const PROJECT_ORDERINGS: ProjectOrdering[] = [
  'target',
  'start',
  'name',
  'progress',
  'created',
  'updated',
];

/** How each ordering reads in the display menu. */
export const PROJECT_ORDERING_LABELS: Record<ProjectOrdering, string> = {
  target: 'Target date',
  start: 'Start date',
  name: 'Name',
  progress: 'Progress',
  created: 'Created',
  updated: 'Last updated',
};

/** What the projects list can group by. */
export type ProjectGrouping = 'status' | 'lead' | 'team' | 'none';

/** The groupings in the order the display menu offers them. */
export const PROJECT_GROUPINGS: ProjectGrouping[] = [
  'status',
  'lead',
  'team',
  'none',
];

/** How each grouping reads in the display menu. */
export const PROJECT_GROUPING_LABELS: Record<ProjectGrouping, string> = {
  status: 'Status',
  lead: 'Lead',
  team: 'Team',
  none: 'No grouping',
};

/** Reads an ordering from a URL value, falling back to target date. */
export const parseOrdering = (value: string | null): ProjectOrdering =>
  PROJECT_ORDERINGS.includes(value as ProjectOrdering)
    ? (value as ProjectOrdering)
    : 'target';

/** Reads a grouping from a URL value, falling back to the page's own. */
export const parseGrouping = (
  value: string | null,
  fallback: ProjectGrouping = 'status'
): ProjectGrouping =>
  PROJECT_GROUPINGS.includes(value as ProjectGrouping)
    ? (value as ProjectGrouping)
    : fallback;

/** Compares two nullable day values, the missing one last. */
const byDate = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
};

/**
 * Sorts projects by an ordering. Dates run soonest first with undated rows
 * last, progress and timestamps run highest and newest first, and every tie
 * falls back to the name so the order is stable.
 */
export const sortProjects = (
  projects: ProjectRead[],
  ordering: ProjectOrdering
): ProjectRead[] => {
  const compare = (left: ProjectRead, right: ProjectRead): number => {
    switch (ordering) {
      case 'target':
        return byDate(left.target_date, right.target_date);
      case 'start':
        return byDate(left.start_date, right.start_date);
      case 'progress':
        return completionPercent(right.counts) - completionPercent(left.counts);
      case 'created':
        return right.created_at.localeCompare(left.created_at);
      case 'updated':
        return right.updated_at.localeCompare(left.updated_at);
      case 'name':
        return 0;
    }
  };
  return [...projects].sort(
    (left, right) => compare(left, right) || left.name.localeCompare(right.name)
  );
};

/** One labelled group of projects. `key` is stable across reads. */
export interface ProjectGroup {
  key: string;
  label: string;
  kind: ProjectGrouping;
  rows: ProjectRead[];
}

/** The group key projects with no lead sit under. */
export const NO_LEAD_KEY = 'lead:none';

/**
 * Groups already sorted projects. Status groups run in the list's order,
 * lead groups by name with "No lead" last, and team groups in the teams'
 * order; a project on several teams shows under each of them. Empty groups
 * are left out, and "none" is one unlabelled group.
 */
export const groupProjects = (
  projects: ProjectRead[],
  grouping: ProjectGrouping,
  people: Assignable[],
  teams: TeamRead[]
): ProjectGroup[] => {
  if (grouping === 'none') {
    return [{ key: 'all', label: 'Projects', kind: 'none', rows: projects }];
  }
  if (grouping === 'status') {
    return PROJECT_STATUS_ORDER.map((status) => ({
      key: `status:${status}`,
      label: PROJECT_STATUS_LABELS[status],
      kind: grouping,
      rows: projects.filter((project) => project.status === status),
    })).filter((group) => group.rows.length > 0);
  }
  if (grouping === 'team') {
    return teams
      .map((team) => ({
        key: `team:${team.id}`,
        label: team.name,
        kind: grouping,
        rows: projects.filter((project) => project.team_ids.includes(team.id)),
      }))
      .filter((group) => group.rows.length > 0);
  }
  const leads = new Map<string, ProjectRead[]>();
  const unled: ProjectRead[] = [];
  for (const project of projects) {
    if (project.lead_id === null) {
      unled.push(project);
      continue;
    }
    leads.set(project.lead_id, [
      ...(leads.get(project.lead_id) ?? []),
      project,
    ]);
  }
  const named = [...leads.entries()]
    .map(([leadId, rows]) => {
      const person = people.find((item) => item.user_id === leadId);
      return {
        key: `lead:${leadId}`,
        label: person === undefined ? 'Unknown lead' : personLabel(person),
        kind: grouping,
        rows,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
  return unled.length === 0
    ? named
    : [
        ...named,
        { key: NO_LEAD_KEY, label: 'No lead', kind: grouping, rows: unled },
      ];
};
