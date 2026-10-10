/**
 * Reports the workspace inbox to the desktop app: the unread count for the
 * dock or taskbar badge, and a native notification for each row that arrives
 * while the app is open. It renders nothing, and in a browser it mounts no
 * hooks, so the web app polls nothing extra.
 */

import React, { useEffect, useRef } from 'react';
import { listInbox } from '../../api/views';
import { useInboxCount } from '../../hooks/useSidebarData';
import { desktopBridge, type DesktopBridge } from '../../lib/desktop';
import { inboxPath } from '../../lib/paths';
import type { NotificationRead } from '../../types/Api';

/** How many of the newest unread rows a rise in the count looks at. */
const NOTIFY_LIMIT = 5;

/** Props for DesktopInboxReporter: the workspace whose inbox to report. */
export interface DesktopInboxReporterProps {
  workspaceId: string;
  slug: string;
}

/** The notification text for one inbox row. */
const describe = (row: NotificationRead): { title: string; body: string } => {
  const subject =
    row.project_name ??
    (row.issue_key === ''
      ? 'Standupless'
      : `${row.issue_key} ${row.issue_title}`);
  return { title: subject, body: `New activity from ${row.actor_name}` };
};

/** The reporter proper, mounted only when the bridge exists. */
const Reporter: React.FC<
  DesktopInboxReporterProps & { bridge: DesktopBridge }
> = ({ workspaceId, slug, bridge }) => {
  const count = useInboxCount(workspaceId);
  const previous = useRef<number | null>(null);
  const seenSince = useRef<string>('');

  useEffect(() => {
    seenSince.current = new Date().toISOString();
  }, []);

  useEffect(() => {
    bridge.setBadgeCount(count ?? 0);
  }, [bridge, count]);

  useEffect(
    () => () => {
      bridge.setBadgeCount(0);
    },
    [bridge]
  );

  useEffect(() => {
    if (count === null) return;
    const before = previous.current;
    previous.current = count;
    if (before === null || count <= before) return;
    const controller = new AbortController();
    void listInbox(
      workspaceId,
      { unread: true, limit: NOTIFY_LIMIT },
      controller.signal
    )
      .then(({ notifications }) => {
        const fresh = notifications.filter(
          (row) => row.created_at > seenSince.current
        );
        if (fresh.length === 0) return;
        seenSince.current = fresh.reduce(
          (latest, row) => (row.created_at > latest ? row.created_at : latest),
          seenSince.current
        );
        for (const row of fresh.reverse()) {
          bridge.notify({
            ...describe(row),
            path: `${inboxPath(slug)}?n=${encodeURIComponent(row.notification_id)}`,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [bridge, count, slug, workspaceId]);

  return null;
};

/** Reports the inbox to the desktop app, or renders nothing in a browser. */
const DesktopInboxReporter: React.FC<DesktopInboxReporterProps> = (props) => {
  const bridge = desktopBridge();
  return bridge === null ? null : <Reporter {...props} bridge={bridge} />;
};

export default DesktopInboxReporter;
