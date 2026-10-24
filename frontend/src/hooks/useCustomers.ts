/**
 * Every customer of the workspace. A workspace keeps a list of customers that
 * fits one read, so the page sorts and searches the whole set in memory.
 */

import { useCallback } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listCustomers } from '../api/customers';
import { customersKey } from '../lib/queryKeys';
import type { CustomerRead } from '../types/Api';

/** How often the customers re-read. */
const POLL_MS = 60000;

/** What {@link useCustomers} hands back. */
export interface WorkspaceCustomers {
  customers: CustomerRead[];
  error: unknown;
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** Reads the workspace's customers. */
export const useCustomers = (
  workspaceId: string,
  enabled = true
): WorkspaceCustomers => {
  const auth = useQueryAuth();
  const queryKey = customersKey(workspaceId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listCustomers(workspaceId, signal),
    [workspaceId]
  );

  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  return { customers: data ?? [], error, isLoading, queryKey };
};

export default useCustomers;
