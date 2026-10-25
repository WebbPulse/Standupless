/**
 * The slim notice that the app has lost its connection. It sits at the foot
 * of the window, away from the toast stack, says the lists are the copy kept
 * on this device and that changes will not save until the connection is
 * back, and leaves as soon as any request gets an answer again. A session
 * refresh that failed for the network shows it too, rather than signing out.
 */

import React from 'react';
import { LuCloudOff } from 'react-icons/lu';
import { useOffline } from '../../hooks/useOffline';

/** Shows the offline notice while the app cannot reach the server. */
export const OfflineBanner: React.FC = () => {
  const offline = useOffline();
  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="screen-only pointer-events-none fixed bottom-4 left-1/2 z-[70] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-overlay px-3 py-1.5 text-xs shadow-overlay"
    >
      <LuCloudOff
        aria-hidden="true"
        className="h-3.5 w-3.5 shrink-0 text-warning"
      />
      <span className="font-medium text-text">Offline</span>
      <span className="truncate text-text-muted">
        Showing what this device saved. Changes will not save until you
        reconnect.
      </span>
    </div>
  );
};

export default OfflineBanner;
