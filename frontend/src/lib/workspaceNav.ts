/**
 * Where the workspace-wide destinations land for the person asking, shared by
 * the shortcuts, the command palette and the sidebar so the three never send
 * the same command to different places.
 */

import { canManageMembers } from './capabilities';
import { apiKeysPath, settingsPath } from './paths';
import type { TeamRead, WorkspaceRead } from '../types/Api';

/**
 * Where workspace settings lands for a role: the workspace page for someone
 * who may manage it, and their own API keys for everyone else, because the
 * workspace page would only tell them they cannot.
 */
export const settingsLanding = (
  workspace: Pick<WorkspaceRead, 'slug' | 'role'>
): string =>
  canManageMembers(workspace.role)
    ? settingsPath(workspace.slug)
    : apiKeysPath(workspace.slug);

/**
 * The team a team-scoped command acts on: the one the route is inside, or
 * the first team the caller can see.
 */
export const currentOrFirstTeam = (
  teams: readonly TeamRead[],
  prefix: string | null
): TeamRead | undefined =>
  (prefix === null
    ? undefined
    : teams.find((team) => team.key_prefix === prefix)) ?? teams[0];
