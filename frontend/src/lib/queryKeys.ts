/**
 * The refetch keys the polled lists register under and the writes invalidate.
 * Kept apart from the components so a component file exports only components
 * and stays refresh safe.
 *
 * Keys are arrays rather than joined strings, because `usePolledQuery` compares
 * them by value and restarts the query when one changes. A list therefore puts
 * its filters and cursor in the key instead of forcing a remount.
 */

import type { QueryKey } from '@webbpulse/api-client/react';
import type { FilterState } from './issueFilters';

/** The filter values an issue list key varies on. */
export type IssueListKeyFilters = FilterState;

/** The caller's workspace list. */
export const WORKSPACES_KEY: QueryKey = ['workspaces'];

/** One workspace's project list. */
export const projectsKey = (workspaceId: string): QueryKey => [
  'projects',
  workspaceId,
];

/** One workspace's member list. */
export const membersKey = (workspaceId: string): QueryKey => [
  'members',
  workspaceId,
];

/** One workspace's invite list. */
export const invitesKey = (workspaceId: string): QueryKey => [
  'invites',
  workspaceId,
];

/** One project's status list. */
export const statusesKey = (projectId: string): QueryKey => [
  'statuses',
  projectId,
];

/** One project's label list. */
export const labelsKey = (projectId: string): QueryKey => ['labels', projectId];

/** One project's member list. */
export const projectMembersKey = (projectId: string): QueryKey => [
  'project-members',
  projectId,
];

/** Builds the link an invited person opens to redeem their invite. */
export const inviteLink = (token: string): string =>
  `${globalThis.location.origin}/invites/accept?token=${encodeURIComponent(token)}`;

/**
 * One issue list. Every filter the read varies on is its own segment, so a
 * filter change is a different key and restarts the query rather than refining
 * the one already held. `scope` names which list this is, because the project
 * tab and the cross-project list read the same route under different fixed
 * filters.
 */
export const issuesKey = (
  workspaceId: string,
  scope: string,
  filters: IssueListKeyFilters
): QueryKey => [
  'issues',
  workspaceId,
  scope,
  filters.statusId,
  filters.assigneeId,
  filters.labelId,
  filters.priority,
  filters.q,
  filters.sort,
];

/** One issue, read by id or resolved from its key. */
export const issueKey = (workspaceId: string, issueId: string): QueryKey => [
  'issue',
  workspaceId,
  issueId,
];

/** One issue's direct children. */
export const childrenKey = (issueId: string): QueryKey => ['children', issueId];

/** One issue's links. */
export const linksKey = (issueId: string): QueryKey => ['links', issueId];

/** One issue's activity. */
export const activityKey = (issueId: string): QueryKey => ['activity', issueId];

/** The candidate parents offered by one issue's parent picker. */
export const parentsKey = (projectId: string): QueryKey => [
  'parents',
  projectId,
];

/** One issue link search, which re-reads as the search term changes. */
export const linkSearchKey = (issueId: string, term: string): QueryKey => [
  'link-search',
  issueId,
  term,
];

/** One issue's comment thread. */
export const commentsKey = (issueId: string): QueryKey => ['comments', issueId];

/** The reaction groups on one issue or comment. */
export const reactionsKey = (
  targetKind: string,
  targetId: string
): QueryKey => ['reactions', targetKind, targetId];

/** One issue's attachments. */
export const attachmentsKey = (issueId: string): QueryKey => [
  'attachments',
  issueId,
];

/**
 * One board. The filters are segments rather than a closed-over object, so
 * changing one restarts the read instead of refining the board already held.
 */
export const boardKey = (
  workspaceId: string,
  projectId: string,
  filters: BoardKeyFilters
): QueryKey => [
  'board',
  workspaceId,
  projectId,
  filters.assigneeId,
  filters.labelId,
  filters.priority,
];

/** The filter values a board key varies on. */
export interface BoardKeyFilters {
  assigneeId: string;
  labelId: string;
  priority: string;
}

/** One workspace's saved views, which vary by the scope asked for. */
export const viewsKey = (
  workspaceId: string,
  scope: string,
  projectId: string
): QueryKey => ['views', workspaceId, scope, projectId];

/** One saved view read by id. */
export const viewKey = (workspaceId: string, viewId: string): QueryKey => [
  'view',
  workspaceId,
  viewId,
];

/**
 * One search. The term is a segment, so typing restarts the read rather than
 * leaving the previous term's hits on screen under the new one.
 */
export const searchKey = (
  workspaceId: string,
  term: string,
  projectId: string
): QueryKey => ['search', workspaceId, term, projectId];

/** The caller's inbox, which varies on whether it is filtered to unread. */
export const inboxKey = (workspaceId: string, unread: boolean): QueryKey => [
  'inbox',
  workspaceId,
  unread,
];

/** The unread badge count, polled by the shell on every page. */
export const inboxCountKey = (workspaceId: string): QueryKey => [
  'inbox-count',
  workspaceId,
];

/** One project's cycle list, which varies on the status filter applied. */
export const cyclesKey = (
  workspaceId: string,
  projectId: string,
  status: string
): QueryKey => ['cycles', workspaceId, projectId, status];

/** One project's milestone list, which varies on the status filter applied. */
export const milestonesKey = (
  workspaceId: string,
  projectId: string,
  status: string
): QueryKey => ['milestones', workspaceId, projectId, status];

/**
 * One workspace's roadmap. The project and kind filters are segments, so
 * narrowing the roadmap restarts the merged read rather than refining a page
 * built from a cursor the old filters produced.
 */
export const roadmapKey = (
  workspaceId: string,
  projectId: string,
  kind: string
): QueryKey => ['roadmap', workspaceId, projectId, kind];

/** The cycles and milestones one issue's pickers choose from. */
export const planningOptionsKey = (projectId: string): QueryKey => [
  'planning-options',
  projectId,
];

/** One workspace's GitHub App installation, or the absence of one. */
export const installationKey = (workspaceId: string): QueryKey => [
  'github-installation',
  workspaceId,
];

/** The repositories one workspace's installation can see. */
export const repositoriesKey = (workspaceId: string): QueryKey => [
  'github-repositories',
  workspaceId,
];

/** The pull requests linked to one issue. */
export const githubLinksKey = (
  workspaceId: string,
  issueId: string
): QueryKey => ['github-links', workspaceId, issueId];

/** One project's pull request transition rules. */
export const transitionsKey = (
  workspaceId: string,
  projectId: string
): QueryKey => ['github-transitions', workspaceId, projectId];

/** One workspace's outbound webhook endpoints. */
export const webhooksKey = (workspaceId: string): QueryKey => [
  'webhooks',
  workspaceId,
];
