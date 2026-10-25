/**
 * The one offline signal every write control reads. It joins the shared
 * client's reachability, which flips on a request that cannot reach the API
 * and back on any answer or the browser's `online` event, with a session
 * refresh that failed at the network layer, so a page disables its writes the
 * moment either notices the connection is gone.
 */

import { useContext } from 'react';
import { useOnline } from '@webbpulse/api-client/react';
import { SessionOfflineContext } from '../contexts/SessionOfflineContext';

/** The hint a write control carries while it is disabled for being offline. */
export const OFFLINE_WRITE_HINT = 'Changes need a connection';

/** Whether the app cannot reach the server, so writes should be held back. */
export const useOffline = (): boolean => {
  const online = useOnline();
  const sessionOffline = useContext(SessionOfflineContext);
  return !online || sessionOffline;
};

/**
 * Whether writes are possible right now: the caller's own permission, held
 * back while offline. Pages pass their capability check through it, so every
 * control that already follows that check disables with no change of its own.
 */
export const useWritable = (permitted: boolean): boolean => {
  const offline = useOffline();
  return permitted && !offline;
};
