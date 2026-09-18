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
