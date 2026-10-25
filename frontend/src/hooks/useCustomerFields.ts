/**
 * The customer statuses and tiers a workspace admin sets up in settings. Both
 * lists are short, so pickers, filters and groups look entries up in memory.
 * Until the statuses arrive the five seeded ones stand in, so a customer's dot
 * keeps its colour on first paint.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listCustomerFields } from '../api/customers';
import { DEFAULT_CUSTOMER_STATUSES } from '../lib/customerDisplay';
import { customerFieldsKey } from '../lib/queryKeys';
import type { CustomerFieldRead } from '../types/Api';

/** How often the lists re-read. */
const POLL_MS = 60000;

/** What {@link useCustomerFields} hands back. */
export interface WorkspaceCustomerFields {
  statuses: CustomerFieldRead[];
  tiers: CustomerFieldRead[];
  error: unknown;
  isLoading: boolean;
  /** The keys the reads run under, for a write to invalidate. */
  statusesKey: QueryKey;
  tiersKey: QueryKey;
}

/** Reads the workspace's customer statuses and tiers. */
export const useCustomerFields = (
  workspaceId: string,
  enabled = true
): WorkspaceCustomerFields => {
  const auth = useQueryAuth();
  const statusesKey = customerFieldsKey(workspaceId, 'statuses');
  const tiersKey = customerFieldsKey(workspaceId, 'tiers');
  const live = enabled && workspaceId !== '';

  const readStatuses = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCustomerFields(workspaceId, 'statuses', signal),
    [workspaceId]
  );
  const readTiers = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCustomerFields(workspaceId, 'tiers', signal),
    [workspaceId]
  );

  const statuses = usePolledQuery(readStatuses, {
    intervalMs: POLL_MS,
    enabled: live,
    queryKey: statusesKey,
    auth,
  });
  const tiers = usePolledQuery(readTiers, {
    intervalMs: POLL_MS,
    enabled: live,
    queryKey: tiersKey,
    auth,
  });

  return {
    statuses: statuses.data ?? DEFAULT_CUSTOMER_STATUSES,
    tiers: tiers.data ?? [],
    error: statuses.error ?? tiers.error,
    isLoading: statuses.isLoading || tiers.isLoading,
    statusesKey,
    tiersKey,
  };
};

export default useCustomerFields;
