/**
 * Browser desktop notifications for the inbox: the permission the browser
 * holds for the site, the per-device switch a person flips in notification
 * settings, and the last inbox row each workspace has notified about. Storage
 * can be missing, full or blocked, so an unreadable switch reads as off, an
 * unreadable mark reads as none, and a refused write is ignored.
 */

/** The browser permission, or `unsupported` where there is no Notification API. */
export type DesktopPermission =
  'default' | 'granted' | 'denied' | 'unsupported';

/** The storage key of this device's on or off switch. */
export const DESKTOP_NOTIFICATIONS_STORAGE_KEY =
  'standupless.desktopNotifications';

/** The prefix of the key each workspace's last notified row is kept under. */
export const DESKTOP_NOTIFIED_STORAGE_PREFIX =
  'standupless.desktopNotifications.last';

/** The last inbox row a workspace notified about, or marked as seen. */
export interface NotifiedMark {
  id: string;
  at: string;
}

/** The storage key of one workspace's last notified row. */
export const notifiedMarkKey = (workspaceId: string): string =>
  `${DESKTOP_NOTIFIED_STORAGE_PREFIX}.${workspaceId}`;

/** Whether this browser has the Notification API. */
export const notificationsSupported = (): boolean =>
  'Notification' in globalThis;

/** The permission the browser holds for this site. */
export const desktopPermission = (): DesktopPermission =>
  notificationsSupported() ? globalThis.Notification.permission : 'unsupported';

/** Asks the browser for permission and answers what it decided. */
export const requestDesktopPermission =
  async (): Promise<DesktopPermission> => {
    if (!notificationsSupported()) return 'unsupported';
    try {
      return await globalThis.Notification.requestPermission();
    } catch {
      return desktopPermission();
    }
  };

/** Whether the switch on this device is on. */
export const readDesktopNotificationsEnabled = (): boolean => {
  try {
    return (
      globalThis.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY) ===
      'on'
    );
  } catch {
    return false;
  }
};

/** Turns the switch on this device on or off. */
export const writeDesktopNotificationsEnabled = (enabled: boolean): void => {
  try {
    globalThis.localStorage.setItem(
      DESKTOP_NOTIFICATIONS_STORAGE_KEY,
      enabled ? 'on' : 'off'
    );
  } catch {
    return;
  }
};

/** Whether new inbox rows should become desktop notifications on this device. */
export const desktopNotificationsActive = (): boolean =>
  desktopPermission() === 'granted' && readDesktopNotificationsEnabled();

/** The last row a workspace notified about, or null when none is kept. */
export const readNotifiedMark = (workspaceId: string): NotifiedMark | null => {
  try {
    const raw = globalThis.localStorage.getItem(notifiedMarkKey(workspaceId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const mark = parsed as Partial<Record<keyof NotifiedMark, unknown>>;
    return typeof mark.id === 'string' && typeof mark.at === 'string'
      ? { id: mark.id, at: mark.at }
      : null;
  } catch {
    return null;
  }
};

/** Keeps the last row a workspace notified about. */
export const writeNotifiedMark = (
  workspaceId: string,
  mark: NotifiedMark
): void => {
  try {
    globalThis.localStorage.setItem(
      notifiedMarkKey(workspaceId),
      JSON.stringify(mark)
    );
  } catch {
    return;
  }
};
