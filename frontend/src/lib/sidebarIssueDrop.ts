/**
 * What a drop of dragged issues on a sidebar item writes, as Linear lands
 * one: a team moves them there through the same path as Move to team, and a
 * project or a cycle sets that property on every issue that can take it. A
 * view, a label, a document or any other item is not a property, so it takes
 * no drop. Every drop is one write with one notice and one undo entry, and
 * the notice counts what was left out: issues the viewer cannot edit, and
 * issues whose team the project or cycle is not on.
 */

import type { OrderedIssueRead } from '../api/issues';
import type {
  FavoriteRead,
  LabelRead,
  StatusRead,
  TeamRead,
  WorkspaceRole,
} from '../types/Api';
import { issueCount, movedNotice, skippedNotice } from './bulkIssueActions';
import { canWriteIssues } from './capabilities';
import type { IssueDragSource } from './issueDrag';
import { isRetired } from './teamRetirement';
import { showToast } from './toast';

/** A sidebar item that takes a drop of issues. */
export type SidebarDropTarget =
  | { kind: 'team'; team: TeamRead }
  | { kind: 'project'; projectId: string; name: string }
  | { kind: 'cycle'; cycleId: string; teamId: string; name: string };

/** A stable key naming one target, for the hovered highlight. */
export const dropTargetKey = (target: SidebarDropTarget): string => {
  switch (target.kind) {
    case 'team':
      return `team:${target.team.id}`;
    case 'project':
      return `project:${target.projectId}`;
    case 'cycle':
      return `cycle:${target.cycleId}`;
  }
};

/** The dragged issues split into those the viewer may write and a count of the rest. */
export const writableIssues = (
  source: Pick<IssueDragSource, 'issues' | 'canEdit'>
): { issues: OrderedIssueRead[]; locked: number } => {
  const issues = source.issues.filter((issue) => source.canEdit(issue));
  return { issues, locked: source.issues.length - issues.length };
};

/** What a property drop writes: the issues it changes and what it left out. */
export interface PropertyDropPlan {
  moving: OrderedIssueRead[];
  locked: number;
  unmatched: number;
  /** Issues already holding the value, which stay as they are. */
  already: number;
}

/**
 * Plans a drop that sets one property: the writable issues whose team `fits`
 * and that do not hold the value already.
 */
export const planPropertyDrop = (
  source: Pick<IssueDragSource, 'issues' | 'canEdit'>,
  fits: (issue: OrderedIssueRead) => boolean,
  holds: (issue: OrderedIssueRead) => boolean
): PropertyDropPlan => {
  const { issues, locked } = writableIssues(source);
  const fitting = issues.filter(fits);
  const moving = fitting.filter((issue) => !holds(issue));
  return {
    moving,
    locked,
    unmatched: issues.length - fitting.length,
    already: fitting.length - moving.length,
  };
};

/**
 * Writes a planned property drop through the view's write, so it shows at
 * once and is one undo entry, or says in a notice why nothing moved.
 */
export const landPropertyDrop = (
  source: Pick<IssueDragSource, 'update'>,
  plan: PropertyDropPlan,
  name: string,
  change: { project_id: string } | { cycle_id: string }
): void => {
  const { moving, locked, unmatched, already } = plan;
  if (moving.length === 0) {
    const skipped = skippedNotice({ locked, unmatched });
    const reason =
      already > 0
        ? `Already in ${name}.`
        : unmatched > 0 && locked === 0
          ? `Nothing moved, ${name} is not on their team.`
          : `Nothing moved. ${skipped}`;
    showToast(
      already > 0 && skipped !== '' ? `${reason} ${skipped}` : reason,
      'info'
    );
    return;
  }
  source.update(
    moving.map((issue) => issue.id),
    change,
    { message: movedNotice(moving, [name], { locked, unmatched }) }
  );
};

/** How many moving issues a team move would remap. */
export interface TeamRemap {
  /** Issues whose status the target team does not show. */
  statuses: number;
  /** Issues carrying a label the target team cannot see. */
  labels: number;
}

/**
 * What a move to a team would remap, from the target's own statuses and
 * labels: a status it does not show maps to its closest one, and a label it
 * cannot see is dropped, as the server's move does.
 */
export const teamRemap = (
  issues: readonly OrderedIssueRead[],
  statuses: readonly Pick<StatusRead, 'id'>[],
  labels: readonly Pick<LabelRead, 'id'>[]
): TeamRemap => {
  const statusIds = new Set(statuses.map((status) => status.id));
  const labelIds = new Set(labels.map((label) => label.id));
  return {
    statuses: issues.filter((issue) => !statusIds.has(issue.status_id)).length,
    labels: issues.filter((issue) =>
      issue.label_ids.some((id) => !labelIds.has(id))
    ).length,
  };
};

/** Whether a team move remaps anything, and so asks first. */
export const remapsAnything = (remap: TeamRemap): boolean =>
  remap.statuses > 0 || remap.labels > 0;

/** The sentence a team move's question states what it remaps with. */
export const remapSentence = (remap: TeamRemap, teamName: string): string => {
  const count = (n: number): string =>
    n === 1 ? '1 issue' : `${String(n)} issues`;
  const parts = [
    ...(remap.statuses > 0
      ? [
          `${count(remap.statuses)} ${remap.statuses === 1 ? 'takes' : 'take'} the closest status ${teamName} has`,
        ]
      : []),
    ...(remap.labels > 0
      ? [
          `${count(remap.labels)} ${remap.labels === 1 ? 'loses' : 'lose'} labels ${teamName} does not have`,
        ]
      : []),
  ];
  return `${parts.join(' and ')}.`;
};

/** The issues a team move takes: the writable ones not in the team already. */
export const planTeamDrop = (
  source: Pick<IssueDragSource, 'issues' | 'canEdit'>,
  team: Pick<TeamRead, 'id'>
): { moving: OrderedIssueRead[]; locked: number } => {
  const { issues, locked } = writableIssues(source);
  return {
    moving: issues.filter((issue) => issue.team_id !== team.id),
    locked,
  };
};

/** The question a team move asks before it remaps. */
export const teamMoveTitle = (
  moving: readonly OrderedIssueRead[],
  team: Pick<TeamRead, 'name'>
): string => `Move ${issueCount(moving)} to ${team.name}?`;

/** Whether the caller may move issues into a team. */
export const takesTeamDrop = (
  team: TeamRead,
  workspaceRole: WorkspaceRole | undefined
): boolean => !isRetired(team) && canWriteIssues(workspaceRole, team.role);

/**
 * The property a favorite stands for when issues are dropped on it: a team, a
 * project, or a cycle that names its team. A view, a label, an issue, a
 * document or an initiative is not a property an issue holds, so it takes none.
 */
export const favoriteDropTarget = (
  favorite: FavoriteRead,
  teams: readonly TeamRead[] | null
): SidebarDropTarget | null => {
  switch (favorite.kind) {
    case 'team': {
      const team = teams?.find((row) => row.id === favorite.target_id);
      return team === undefined ? null : { kind: 'team', team };
    }
    case 'project':
      return {
        kind: 'project',
        projectId: favorite.target_id,
        name: favorite.title,
      };
    case 'cycle':
      return typeof favorite.team_id === 'string' && favorite.team_id !== ''
        ? {
            kind: 'cycle',
            cycleId: favorite.target_id,
            teamId: favorite.team_id,
            name: favorite.title,
          }
        : null;
    default:
      return null;
  }
};
