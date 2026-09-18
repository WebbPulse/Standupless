/**
 * The refetch keys the polled lists register under and the writes invalidate.
 * Kept apart from the components so a component file exports only components
 * and stays refresh safe.
 */

/** The caller's workspace list. */
export const WORKSPACES_KEY = 'workspaces';

/** One workspace's project list. */
export const projectsKey = (workspaceId: string): string =>
  `projects:${workspaceId}`;

/** One workspace's member list. */
export const membersKey = (workspaceId: string): string =>
  `members:${workspaceId}`;

/** One workspace's invite list. */
export const invitesKey = (workspaceId: string): string =>
  `invites:${workspaceId}`;

/** One project's status list. */
export const statusesKey = (projectId: string): string =>
  `statuses:${projectId}`;

/** One project's label list. */
export const labelsKey = (projectId: string): string => `labels:${projectId}`;

/** One project's member list. */
export const projectMembersKey = (projectId: string): string =>
  `project-members:${projectId}`;

/** Builds the link an invited person opens to redeem their invite. */
export const inviteLink = (token: string): string =>
  `${globalThis.location.origin}/invites/accept?token=${encodeURIComponent(token)}`;

/**
 * One issue list. The filters are part of the key, because a filter change is a
 * different read rather than a refinement of the one already held.
 */
export const issuesKey = (workspaceId: string, filters: string): string =>
  `issues:${workspaceId}:${filters}`;

/** One issue, read by id or resolved from its key. */
export const issueKey = (workspaceId: string, issueId: string): string =>
  `issue:${workspaceId}:${issueId}`;

/** One issue's direct children. */
export const childrenKey = (issueId: string): string => `children:${issueId}`;

/** One issue's links. */
export const linksKey = (issueId: string): string => `links:${issueId}`;

/** One issue's activity. */
export const activityKey = (issueId: string): string => `activity:${issueId}`;
