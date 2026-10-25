/**
 * Whether the caller is the last owner of a workspace, the one standing the
 * API refuses to let leave. Only an owner's roster is read, since nobody else
 * can be the last owner.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listMembers } from '../api/workspaces';
import { LOOKUP_POLL_MS } from '../lib/polling';
import { membersKey } from '../lib/queryKeys';
import type { WorkspaceRead } from '../types/Api';

/** What {@link useLastOwner} hands back. */
export interface LastOwnerState {
  /** True when the caller is an owner and no other member is one. */
  lastOwner: boolean;
  /** True while an owner's roster is still being read. */
  checking: boolean;
}

/** Reads whether the caller is the workspace's last owner. */
export const useLastOwner = (
  workspace: Pick<WorkspaceRead, 'id' | 'role'>,
  enabled = true
): LastOwnerState => {
  const auth = useQueryAuth();
  const owner = workspace.role === 'owner';
  const { data } = usePolledQuery(
    (context) => listMembers(workspace.id, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: enabled && owner && workspace.id !== '',
      queryKey: membersKey(workspace.id),
      auth,
    }
  );
  if (!owner) return { lastOwner: false, checking: false };
  if (data === null) return { lastOwner: false, checking: true };
  const owners = data.filter((member) => member.role === 'owner').length;
  return { lastOwner: owners <= 1, checking: false };
};

/** Why the last owner cannot leave, naming the workspace. */
export const lastOwnerReason = (name: string): string =>
  `You are the only owner of ${name}. Make another member an owner before you leave.`;

export default useLastOwner;
