/**
 * The one offline signal every write control reads. It follows the
 * connectivity monitor, which joins the shared client's reachability with a
 * session refresh that failed at the network layer, probes the API the moment
 * either reports trouble, and only calls the app offline once the browser says
 * so or the trouble outlasts a short grace period. A dropped request on an
 * idle page is disproved by the probe, so it neither shows the offline notice
 * nor disables every write control.
 */

import { useConfirmedOffline } from '../lib/connectivity';

/** The hint a write control carries while it is disabled for being offline. */
export const OFFLINE_WRITE_HINT = 'Changes need a connection';

/** Whether the app cannot reach the server, so writes should be held back. */
export const useOffline = (): boolean => useConfirmedOffline();

/**
 * Whether writes are possible right now: the caller's own permission, held
 * back while offline. Pages pass their capability check through it, so every
 * control that already follows that check disables with no change of its own.
 */
export const useWritable = (permitted: boolean): boolean => {
  const offline = useOffline();
  return permitted && !offline;
};
