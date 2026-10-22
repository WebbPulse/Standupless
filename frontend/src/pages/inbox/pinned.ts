/**
 * Keeps the inbox's open row on screen after a refetch leaves it out, as a
 * list hiding read rows does once opening a row marks it read.
 */

import type { InboxGroup } from './groups';

/** The open row and where it sat, kept on screen after a refetch drops it. */
export interface PinnedRow {
  group: InboxGroup;
  index: number;
}

/**
 * Puts the open row back at its old place when the fetched list no longer
 * holds it, so marking a row read while read rows are hidden does not close it.
 */
export const keepPinned = (
  groups: InboxGroup[],
  pinned: PinnedRow | null,
  selectedId: string | null
): InboxGroup[] => {
  if (
    pinned === null ||
    selectedId === null ||
    !pinned.group.rows.some((row) => row.notification_id === selectedId)
  )
    return groups;
  if (groups.some((group) => group.key === pinned.group.key)) return groups;
  const at = Math.min(pinned.index, groups.length);
  return [...groups.slice(0, at), pinned.group, ...groups.slice(at)];
};
