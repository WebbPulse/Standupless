/**
 * What each role may do, read from the "Who" column of the M1 API contract.
 * These decide what the UI offers, never whether an action is allowed: the
 * server authorizes every call, and hiding a control is presentation only.
 */

import type { ProjectRole, WorkspaceRole } from '../types/Api';

/** Whether the role may delete the workspace or transfer ownership. */
export const canDeleteWorkspace = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner';

/** Whether the role may rename the workspace. */
export const canEditWorkspace = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin';

/** Whether the role may read and change the member list and invites. */
export const canManageMembers = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin';

/**
 * Whether the role may grant or remove `owner`. The contract reserves this to
 * an owner even though an admin may otherwise change roles.
 */
export const canGrantOwner = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner';

/** Whether the role may create a project. A guest may not. */
export const canCreateProject = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin' || role === 'member';

/** Whether the role may delete a project, which the contract reserves. */
export const canDeleteProject = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin';

/**
 * Whether the caller administers a project: a workspace owner or admin, or a
 * project member holding `admin`. The project role the API reports already
 * folds the workspace role in, so it is sufficient on its own when present.
 */
export const isProjectAdmin = (
  workspaceRole: WorkspaceRole | undefined,
  projectRole: ProjectRole | undefined
): boolean =>
  workspaceRole === 'owner' ||
  workspaceRole === 'admin' ||
  projectRole === 'admin';

/** The roles a member's role may be changed to, given the caller's own role. */
export const assignableRoles = (
  callerRole: WorkspaceRole | undefined
): WorkspaceRole[] =>
  canGrantOwner(callerRole)
    ? ['owner', 'admin', 'member', 'guest']
    : ['admin', 'member', 'guest'];

/** How a role reads in the interface. */
export const roleLabel = (role: WorkspaceRole | ProjectRole): string =>
  role.charAt(0).toUpperCase() + role.slice(1);

/**
 * Whether the caller may write issues in a project. Every role the projects
 * route reports carries at least project membership, and a guest without one
 * never sees the project at all, so the presence of a role is the gate.
 */
export const canWriteIssues = (
  workspaceRole: WorkspaceRole | undefined,
  projectRole: ProjectRole | undefined
): boolean =>
  workspaceRole === 'owner' ||
  workspaceRole === 'admin' ||
  workspaceRole === 'member' ||
  projectRole === 'admin' ||
  projectRole === 'member';

/**
 * Whether the caller may delete any issue in a project. The contract also lets
 * a creator delete a childless issue of their own, which the server decides,
 * so the page offers delete to a project admin and leaves the rest to a refusal.
 */
export const canDeleteAnyIssue = (
  workspaceRole: WorkspaceRole | undefined,
  projectRole: ProjectRole | undefined
): boolean => isProjectAdmin(workspaceRole, projectRole);
