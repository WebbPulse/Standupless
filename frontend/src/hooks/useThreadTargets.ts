/**
 * The linked pull requests and GitHub issue an issue's comment threads may be
 * synced to, read once for the whole timeline on a slow poll. The composer and
 * every thread's menu take this one list as a prop, so a timeline of many
 * threads makes one request rather than one per card.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listThreadTargets } from '../api/integrations';
import { threadTargetsKey } from '../lib/queryKeys';
import type { GithubThreadTargetRead } from '../types/Api';

/** How often the list re-reads; links change when a pull request opens. */
const POLL_MS = 60000;

/** Reads where one issue's threads may be synced, empty when nothing is linked. */
export const useThreadTargets = (
  workspaceId: string,
  issueId: string,
  enabled = true
): GithubThreadTargetRead[] => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) => listThreadTargets(workspaceId, issueId, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && workspaceId !== '' && issueId !== '',
      queryKey: threadTargetsKey(workspaceId, issueId),
      auth,
    }
  );
  return data ?? [];
};

export default useThreadTargets;
