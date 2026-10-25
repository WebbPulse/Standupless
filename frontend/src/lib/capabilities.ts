/**
 * What each role may do, read from the "Who" column of the M1 API contract.
 * These decide what the UI offers, never whether an action is allowed: the
 * server authorizes every call, and hiding a control is presentation only.
 */

import type {
  PermissionLevel,
  TeamRole,
  WorkspaceRead,
  WorkspaceRole,
} from '../types/Api';

/** Whether the role may schedule or cancel the workspace's deletion. */
export const canDeleteWorkspace = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin';

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

/**
 * Whether the role may create a team. A guest never may, and a member only
 * while the workspace lets every member create teams, which is the default.
 */
export const canCreateTeam = (
  role: WorkspaceRole | undefined,
  permission: PermissionLevel | undefined = 'members'
): boolean =>
  role === 'owner' ||
  role === 'admin' ||
  (role === 'member' && permission === 'members');

/**
 * Whether the caller may invite people. Admins always may, and a member only
 * while the workspace lets every member invite. A guest never may.
 */
export const canInviteMembers = (
  workspace: Pick<WorkspaceRead, 'role' | 'invite_permission'>
): boolean =>
  canManageMembers(workspace.role) ||
  (workspace.role === 'member' && workspace.invite_permission === 'members');

/** Whether the role may delete a team, which the contract reserves. */
export const canDeleteTeam = (role: WorkspaceRole | undefined): boolean =>
  role === 'owner' || role === 'admin';

/**
 * Whether the caller administers a team: a workspace owner or admin, or a
 * team member holding `admin`. The team role the API reports already
 * folds the workspace role in, so it is sufficient on its own when present.
 */
export const isTeamAdmin = (
  workspaceRole: WorkspaceRole | undefined,
  teamRole: TeamRole | undefined
): boolean =>
  workspaceRole === 'owner' ||
  workspaceRole === 'admin' ||
  teamRole === 'admin';

/** The roles a member's role may be changed to, given the caller's own role. */
export const assignableRoles = (
  callerRole: WorkspaceRole | undefined
): WorkspaceRole[] =>
  canGrantOwner(callerRole)
    ? ['owner', 'admin', 'member', 'guest']
    : ['admin', 'member', 'guest'];

/** How a role reads in the interface. */
export const roleLabel = (role: WorkspaceRole | TeamRole): string =>
  role.charAt(0).toUpperCase() + role.slice(1);

/**
 * Whether the caller may write issues in a team. Every role the teams
 * route reports carries at least team membership, and a guest without one
 * never sees the team at all, so the presence of a role is the gate.
 */
export const canWriteIssues = (
  workspaceRole: WorkspaceRole | undefined,
  teamRole: TeamRole | undefined
): boolean =>
  workspaceRole === 'owner' ||
  workspaceRole === 'admin' ||
  workspaceRole === 'member' ||
  teamRole === 'admin' ||
  teamRole === 'member';

/**
 * Whether the caller may delete any issue in a team. The contract also lets
 * a creator delete a childless issue of their own, which the server decides,
 * so the page offers delete to a team admin and leaves the rest to a refusal.
 */
export const canDeleteAnyIssue = (
  workspaceRole: WorkspaceRole | undefined,
  teamRole: TeamRole | undefined
): boolean => isTeamAdmin(workspaceRole, teamRole);
