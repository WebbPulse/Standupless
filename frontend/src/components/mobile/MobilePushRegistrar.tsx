/**
 * Registers the phone for push while a workspace is open, and renders nothing.
 *
 * Mounted under a workspace because the server needs one to authorize the call,
 * and because each workspace opened joins what the app icon's badge counts.
 * Registering again each time also keeps a phone in use from aging out. In a
 * browser, or an app released before push, it does nothing.
 */

import { useEffect } from 'react';
import { startMobilePush } from '../../lib/mobilePush';

/** Starts push for one workspace and stops listening when it closes. */
const MobilePushRegistrar = ({
  workspaceId,
}: {
  workspaceId: string;
}): null => {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void startMobilePush(workspaceId)
      .then((stopListening) => {
        if (disposed) stopListening();
        else stop = stopListening;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      stop?.();
    };
  }, [workspaceId]);

  return null;
};

export default MobilePushRegistrar;
