/**
 * A saved view of projects, translated to and from the projects page. The
 * page filters by a team's key prefix, a set of statuses and one lead, and a
 * view stores the team by id, so these helpers are the one place that maps
 * between the two. Opened as a view, the page treats the view as its base:
 * the URL only carries what differs from it, and saving writes the page's
 * state back as the view's filter and arrangement.
 */

import type { ProjectViewFilter, SavedViewDisplayRead } from '../api/views';
import type { ProjectStatus, TeamRead } from '../types/Api';
import { PROJECT_STATUS_ORDER } from './planningModel';
import { resolveDisplay, type ProjectsDisplay } from './projectList';

/** The projects page state a view of projects opens on. */
export interface ProjectViewBase {
  /** The team filter as the page holds it, a key prefix, or the stored id when no visible team has it. */
  team: string;
  /** The stored team id, kept so a team the caller cannot see survives a save. */
  teamId: string;
  status: ProjectStatus[];
  /** A lead's user id, `none` for projects without one, or empty. */
  lead: string;
  /** Whether a parent team rolls up its sub-teams' projects. */
  rollUp: boolean;
  display: ProjectsDisplay;
}

/** The page state a view of projects is saved from. */
export interface ProjectViewState {
  teamId: string;
  status: readonly ProjectStatus[];
  lead: string;
  rollUp: boolean;
}

/** A stored value that may be one text or a list of them, as a list. */
const asList = (value: string | readonly string[] | undefined): string[] =>
  value === undefined ? [] : typeof value === 'string' ? [value] : [...value];

/** The statuses in the page's order, unknown ones dropped. */
export const orderedStatuses = (values: readonly string[]): ProjectStatus[] =>
  PROJECT_STATUS_ORDER.filter((status) => values.includes(status));

/** The filter a view of projects stores, read whether it holds one value or a list. */
export const projectViewFilter = (
  view: Pick<SavedViewDisplayRead, 'filter'>
): ProjectViewFilter => view.filter as unknown as ProjectViewFilter;

/** The page state a view of projects opens on. */
export const projectViewBase = (
  view: Pick<SavedViewDisplayRead, 'filter' | 'projects_display'>,
  teams: readonly TeamRead[]
): ProjectViewBase => {
  const filter = projectViewFilter(view);
  const teamId = typeof filter.team_id === 'string' ? filter.team_id : '';
  const team =
    teamId === ''
      ? ''
      : (teams.find((candidate) => candidate.id === teamId)?.key_prefix ??
        teamId);
  return {
    team,
    teamId,
    status: orderedStatuses(asList(filter.status)),
    lead: asList(filter.lead_id)[0] ?? '',
    rollUp: filter.sub_teams !== 'false',
    display: resolveDisplay(() => null, view.projects_display ?? undefined),
  };
};

/** The filter a view of projects is saved with, holding only what narrows the page. */
export const toProjectViewFilter = (
  state: ProjectViewState
): ProjectViewFilter => ({
  ...(state.teamId === '' ? {} : { team_id: state.teamId }),
  ...(state.status.length === 0
    ? {}
    : { status: orderedStatuses(state.status) }),
  ...(state.lead === '' ? {} : { lead_id: [state.lead] }),
  ...(state.teamId !== '' && !state.rollUp
    ? { sub_teams: 'false' as const }
    : {}),
});

/** Whether two project filters narrow the page the same way. */
export const sameProjectFilter = (
  left: ProjectViewFilter,
  right: ProjectViewFilter
): boolean =>
  (left.team_id ?? '') === (right.team_id ?? '') &&
  orderedStatuses(asList(left.status)).join(',') ===
    orderedStatuses(asList(right.status)).join(',') &&
  asList(left.lead_id).join(',') === asList(right.lead_id).join(',') &&
  (left.sub_teams ?? 'true') === (right.sub_teams ?? 'true');
