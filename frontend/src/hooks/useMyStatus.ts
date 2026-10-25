/**
 * The signed in person's own status in the current workspace, and a way to set
 * or clear it. The status lives on the person's workspace member row, so it is
 * read from the member list the pickers already share, and a change re-reads
 * that list and every team's, so the pickers, mentions and cards pick it up.
 */

import { useCallback, useEffect, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { clearMyStatus, setMyStatus } from '../api/workspaces';
import { memberProfileKey, membersKey, teamMembersKey } from '../lib/queryKeys';
import { statusInForce } from '../lib/userStatus';
import type { UserStatusRead, UserStatusUpdate } from '../types/Api';
import { useAuth } from './useAuth';
import { useTeamsFor } from './useTeams';
import { useWorkspaceMembers } from './useWorkspaceMembers';

/** How often the status is re-read against the clock, so one that ended clears on its own. */
const TICK_MS = 30000;

/** What useMyStatus answers. */
export interface MyStatus {
  /** The status in force, or null when none is set or it has ended. */
  status: UserStatusRead | null;
  saving: boolean;
  error: unknown;
  /** Sets the status, answering whether the server kept it. */
  save: (body: UserStatusUpdate) => Promise<boolean>;
  /** Clears the status, answering whether the server kept the change. */
  clear: () => Promise<boolean>;
}

/** The caller's own status in `workspaceId`. */
export const useMyStatus = (workspaceId: string): MyStatus => {
  const { user } = useAuth();
  const members = useWorkspaceMembers(workspaceId);
  const { data: teams } = useTeamsFor(workspaceId);
  const [now, setNow] = useState(() => new Date());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [written, setWritten] = useState<{
    status: UserStatusRead | null;
    over: UserStatusRead | null;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date());
    }, TICK_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const userId = user?.id ?? '';
  const listed =
    members.find((member) => member.user_id === userId)?.user_status ?? null;

  const run = useCallback(
    async (write: () => Promise<{ user_status?: UserStatusRead | null }>) => {
      if (workspaceId === '') return false;
      setSaving(true);
      setError(null);
      try {
        const row = await write();
        setWritten({ status: row.user_status ?? null, over: listed });
        invalidateQueries([
          membersKey(workspaceId),
          memberProfileKey(workspaceId, userId),
          ...(teams ?? []).map((team) => teamMembersKey(team.id)),
        ]);
        setNow(new Date());
        return true;
      } catch (failure: unknown) {
        setError(failure);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, userId, teams, listed]
  );

  return {
    status: statusInForce(
      written !== null && written.over === listed ? written.status : listed,
      now
    ),
    saving,
    error,
    save: (body) => run(() => setMyStatus(workspaceId, body)),
    clear: () => run(() => clearMyStatus(workspaceId)),
  };
};

export default useMyStatus;
