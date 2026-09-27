/**
 * Keeps the inbox's open row on screen after a refetch leaves it out, as the
 * Unread tab does once opening a row marks it read.
 */

import type { NotificationRead } from '../../types/Api';

/** The open row and where it sat, kept on screen after a refetch drops it. */
export interface PinnedRow {
  row: NotificationRead;
  index: number;
}

/**
 * Puts the open row back at its old place when the fetched list no longer
 * holds it, so marking a row read in the Unread tab does not close it.
 */
export const keepPinned = (
  rows: NotificationRead[],
  pinned: PinnedRow | null,
  selectedId: string | null
): NotificationRead[] => {
  if (pinned === null || pinned.row.notification_id !== selectedId) return rows;
  if (rows.some((row) => row.notification_id === selectedId)) return rows;
  const at = Math.min(pinned.index, rows.length);
  return [...rows.slice(0, at), pinned.row, ...rows.slice(at)];
};
