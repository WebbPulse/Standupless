/**
 * Shows a browser desktop notification for each inbox row that arrives while
 * the web app is open in a tab the person is not looking at. The polled unread
 * count is the trigger: when it changes, the newest unread rows are read and
 * anything newer than the workspace's last notified row is shown, one
 * notification each, or one summary beyond a small burst.
 *
 * The last notified row is kept per workspace on the device, so a reload or a
 * second tab does not notify again, and the first read on a device only marks
 * where to start. A focused tab only moves the mark, since the person can see
 * the badge. The desktop app notifies natively, so inside it nothing happens,
 * and until the switch is on and the browser allows it nothing is read.
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { listInbox } from '../api/views';
import { useInboxCount } from './useSidebarData';
import {
  desktopNotificationsActive,
  readNotifiedMark,
  writeNotifiedMark,
  type NotifiedMark,
} from '../lib/desktopNotifications';
import { isDesktopShell } from '../lib/desktop';
import { inboxPath, issuePath } from '../lib/paths';
import type { NotificationRead, WorkspaceRead } from '../types/Api';

/** How many of the newest unread rows one change in the count reads. */
export const DESKTOP_NOTIFY_LIMIT = 10;

/** The most rows shown one by one before a single summary takes their place. */
export const DESKTOP_NOTIFY_BURST = 3;

/** The unread count each workspace last acted on, kept across page mounts. */
const actedOn = new Map<string, number>();

/** Whether the person is looking at this tab right now. */
const tabFocused = (): boolean =>
  document.visibilityState === 'visible' && document.hasFocus();

/** Whether a row came after the mark. */
const isNewer = (row: NotificationRead, mark: NotifiedMark): boolean =>
  row.created_at > mark.at ||
  (row.created_at === mark.at && row.notification_id > mark.id);

/** The mark for the newest of some rows. */
const markOf = (rows: NotificationRead[]): NotifiedMark =>
  rows.reduce<NotifiedMark>(
    (latest, row) =>
      isNewer(row, latest)
        ? { id: row.notification_id, at: row.created_at }
        : latest,
    { id: '', at: '' }
  );

/** The notification text for one inbox row: what it is about, then who did what. */
export const describeRow = (
  row: NotificationRead
): { title: string; body: string } => {
  const title =
    row.project_name ??
    row.initiative_name ??
    (row.issue_key === ''
      ? 'Standupless'
      : `${row.issue_key} ${row.issue_title}`);
  const summary = row.summary ?? '';
  return {
    title,
    body: summary === '' ? `New activity from ${row.actor_name}` : summary,
  };
};

/** Where clicking a row's notification goes: its issue, or the row in the inbox. */
const pathOf = (slug: string, row: NotificationRead): string =>
  row.issue_key === ''
    ? `${inboxPath(slug)}?n=${encodeURIComponent(row.notification_id)}`
    : issuePath(slug, row.issue_key);

/** Notifies about new inbox rows in a browser tab that is not focused. */
export const useDesktopNotifications = (
  workspace: WorkspaceRead | null
): void => {
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const watching =
    workspace !== null && !isDesktopShell() && desktopNotificationsActive();
  const count = useInboxCount(watching ? workspaceId : '');
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);

  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  useEffect(() => {
    if (workspaceId === '' || count === null) return;
    if (isDesktopShell() || !desktopNotificationsActive()) return;
    const before = actedOn.get(workspaceId);
    actedOn.set(workspaceId, count);
    if (count === 0 || count === before) return;

    const show = (title: string, body: string, tag: string, path: string) => {
      const notification = new Notification(title, { body, tag });
      notification.onclick = () => {
        window.focus();
        notification.close();
        void navigateRef.current(path);
      };
    };

    void listInbox(workspaceId, { unread: true, limit: DESKTOP_NOTIFY_LIMIT })
      .then(({ notifications }) => {
        if (notifications.length === 0) return;
        const mark = readNotifiedMark(workspaceId);
        const fresh =
          mark === null
            ? []
            : notifications.filter((row) => isNewer(row, mark));
        if (mark !== null && fresh.length === 0) return;
        writeNotifiedMark(
          workspaceId,
          markOf(mark === null ? notifications : fresh)
        );
        if (fresh.length === 0 || tabFocused()) return;
        if (fresh.length > DESKTOP_NOTIFY_BURST) {
          show(
            'Standupless',
            `${fresh.length} new notifications in your inbox`,
            `inbox-${workspaceId}`,
            inboxPath(slug)
          );
          return;
        }
        for (const row of [...fresh].reverse()) {
          const { title, body } = describeRow(row);
          show(title, body, row.notification_id, pathOf(slug, row));
        }
      })
      .catch(() => undefined);
  }, [count, slug, workspaceId]);
};
