/**
 * Registering this phone for native push, and letting go of it on sign-out.
 *
 * The server keeps one owner per token, so a sign-out that never reaches it is
 * corrected by the next person's registration. That is why sign-out waits only
 * briefly: being offline must not stop anyone signing out.
 */

import { registerPushDevice, unregisterPushDevice } from '../api/views';
import { canUseMobilePush } from './mobile';

/** Where the registered token is kept, for the request sign-out makes. */
const DEVICE_KEY = 'standupless.push-device';

/** How long sign-out waits for the server to let go of this phone. */
export const STOP_WAIT_MS = 1500;

/** What sign-out needs to name this phone to the server. */
interface StoredDevice {
  token: string;
  workspaceId: string;
}

/** Remembers the token this phone registered, ignoring a storage that refuses. */
const storeDevice = (device: StoredDevice): void => {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(device));
  } catch {
    void 0;
  }
};

/** The token this phone registered, or null when none is stored or it is unreadable. */
const storedDevice = (): StoredDevice | null => {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDevice>;
    return typeof parsed.token === 'string' &&
      typeof parsed.workspaceId === 'string'
      ? { token: parsed.token, workspaceId: parsed.workspaceId }
      : null;
  } catch {
    return null;
  }
};

/** Forgets the stored token, ignoring a storage that refuses. */
const forgetDevice = (): void => {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    void 0;
  }
};

/**
 * Asks for permission if it was never asked, then registers this phone for one
 * workspace. Answers with what stops listening for the token, and does nothing
 * where push is unavailable or was refused.
 */
export const startMobilePush = async (
  workspaceId: string
): Promise<() => void> => {
  if (!canUseMobilePush()) return () => undefined;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const current = await PushNotifications.checkPermissions();
  const permission =
    current.receive === 'granted' || current.receive === 'denied'
      ? current.receive
      : (await PushNotifications.requestPermissions()).receive;
  if (permission !== 'granted') return () => undefined;
  const handle = await PushNotifications.addListener(
    'registration',
    ({ value }) => {
      void registerPushDevice(workspaceId, value)
        .then(() => {
          storeDevice({ token: value, workspaceId });
        })
        .catch(() => undefined);
    }
  );
  await PushNotifications.register();
  return () => {
    void handle.remove();
  };
};

/**
 * Stops push to this phone before the session ends, and takes the delivered
 * notifications off the lock screen, since the next person should not see them.
 * Waits at most `STOP_WAIT_MS` and never rejects.
 */
export const stopMobilePush = async (): Promise<void> => {
  const device = storedDevice();
  forgetDevice();
  if (canUseMobilePush()) {
    void import('@capacitor/push-notifications')
      .then(({ PushNotifications }) =>
        PushNotifications.removeAllDeliveredNotifications()
      )
      .catch(() => undefined);
  }
  if (device === null) return;
  await Promise.race([
    unregisterPushDevice(device.workspaceId, device.token).catch(
      () => undefined
    ),
    new Promise<void>((resolve) => {
      setTimeout(resolve, STOP_WAIT_MS);
    }),
  ]);
};
