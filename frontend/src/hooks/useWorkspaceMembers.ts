/**
 * The workspace's members, for pickers on workspace level records such as an
 * initiative's owner, which are not bound to any one team's membership.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listMembers } from '../api/workspaces';
import { membersKey } from '../lib/queryKeys';
import type { MemberRead } from '../types/Api';
import { LOOKUP_POLL_MS } from '../lib/polling';

/** Reads the workspace's members, or nothing until there is a workspace. */
export const useWorkspaceMembers = (
  workspaceId: string,
  enabled = true
): MemberRead[] => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    (context) => listMembers(workspaceId, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: enabled && workspaceId !== '',
      queryKey: membersKey(workspaceId),
      auth,
    }
  );
  return data ?? [];
};

export default useWorkspaceMembers;
