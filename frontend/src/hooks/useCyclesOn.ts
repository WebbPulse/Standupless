/**
 * Whether a team runs on an automatic cycle schedule, which is what turns
 * cycles on for it, so the sidebar can offer its current cycle. Read only
 * while asked for, so a collapsed team section costs no request.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getCycleSettings } from '../api/teams';
import { LOOKUP_POLL_MS } from '../lib/polling';
import { cycleSettingsKey } from '../lib/queryKeys';

/** True once the team's schedule has been read and is enabled. */
export const useCyclesOn = (
  workspaceId: string,
  teamId: string,
  enabled: boolean
): boolean => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => getCycleSettings(workspaceId, teamId, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: enabled && workspaceId !== '' && teamId !== '',
      queryKey: cycleSettingsKey(workspaceId, teamId),
      auth,
    }
  );
  return data?.enabled === true;
};

export default useCyclesOn;
