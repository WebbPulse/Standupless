/**
 * Which customers requested each issue, read from the workspace's request
 * list, so a list grouped by customer places an issue under every customer
 * that asked for it.
 */

import { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import { listWorkspaceRequests } from '../api/customers';
import { workspaceCustomerRequestsKey } from '../lib/queryKeys';
import type { CustomerRequestRead } from '../types/Api';

/** How often the requests re-read. */
const POLL_MS = 60000;

/** What {@link useCustomerRequestMap} hands back. */
export interface CustomerRequestMap {
  /** The customer ids that requested each issue, by issue id. */
  byIssue: ReadonlyMap<string, readonly string[]>;
  /** The issue requests themselves, for a write that removes one. */
  requests: CustomerRequestRead[];
  isLoading: boolean;
  /** The key the read runs under, for a write to invalidate. */
  queryKey: QueryKey;
}

/** The customer ids naming each issue, from a list of requests. */
export const customersByIssue = (
  requests: readonly CustomerRequestRead[]
): Map<string, string[]> => {
  const byIssue = new Map<string, string[]>();
  for (const request of requests) {
    if (request.target_kind !== 'issue') continue;
    const held = byIssue.get(request.target_id) ?? [];
    if (!held.includes(request.customer_id)) held.push(request.customer_id);
    byIssue.set(request.target_id, held);
  }
  return byIssue;
};

/** Reads the workspace's issue requests while `enabled` holds. */
export const useCustomerRequestMap = (
  workspaceId: string,
  enabled: boolean
): CustomerRequestMap => {
  const auth = useQueryAuth();
  const queryKey = workspaceCustomerRequestsKey(workspaceId);

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listWorkspaceRequests(workspaceId, signal),
    [workspaceId]
  );

  const { data, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey,
    auth,
  });

  const requests = useMemo(
    () => (data ?? []).filter((request) => request.target_kind === 'issue'),
    [data]
  );
  const byIssue = useMemo(() => customersByIssue(requests), [requests]);

  return { byIssue, requests, isLoading, queryKey };
};

export default useCustomerRequestMap;
