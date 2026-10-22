/**
 * The undo history for issue changes: a module scoped stack, read by Ctrl+Z,
 * the command palette and each change's own notice. Kept free of React, like
 * `lib/toast`, so a write helper can record a change without threading a
 * context through. An entry holds the write that puts the change back, which
 * goes through the same routes as any edit, so activity records the undo.
 */

import { errorMessage } from './errors';
import { dismissToast, showErrorToast, showToast } from './toast';

/** How long a change's notice offers Undo before it dismisses itself. */
export const UNDO_TOAST_MS = 5000;

/** The most changes held; the oldest give way. */
export const UNDO_LIMIT = 20;

/** The label every change's notice gives its undo button. */
export const UNDO_LABEL = 'Undo';

/** One change that can be put back. */
export interface UndoEntry {
  id: number;
  /** The workspace the change was made in; undo only reaches its own. */
  workspaceId: string;
  /** What the change's notice said, such as "Changed status of ABC-1". */
  message: string;
  /** Writes the previous values back. Rejects when the write fails. */
  revert: () => Promise<void>;
}

let entries: UndoEntry[] = [];
let nextId = 1;
const toastIds = new Map<number, number>();
const listeners = new Set<() => void>();

/** Tells every subscriber the history changed. */
const emit = (): void => {
  for (const listener of [...listeners]) listener();
};

/** Subscribes to history changes, answering the unsubscribe. */
export const subscribeUndo = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Every change held now, oldest first. */
export const currentUndo = (): UndoEntry[] => entries;

/** The most recent change held for a workspace, or undefined. */
export const lastUndo = (workspaceId: string): UndoEntry | undefined =>
  [...entries].reverse().find((entry) => entry.workspaceId === workspaceId);

/** Whether a workspace has a change to undo. */
export const canUndo = (workspaceId: string): boolean =>
  lastUndo(workspaceId) !== undefined;

/** Takes down the notice an entry raised, if it is still showing. */
const dropToast = (id: number): void => {
  const toastId = toastIds.get(id);
  toastIds.delete(id);
  if (toastId !== undefined) dismissToast(toastId);
};

/**
 * Removes one entry and writes its previous values back, answering whether
 * there was an entry to undo. A failed write says so in a notice and never
 * rejects.
 */
export const runUndo = async (id: number): Promise<boolean> => {
  const entry = entries.find((held) => held.id === id);
  if (entry === undefined) return false;
  entries = entries.filter((held) => held.id !== id);
  dropToast(id);
  emit();
  try {
    await entry.revert();
    showToast('Change undone');
  } catch (cause) {
    showErrorToast(errorMessage(cause, 'Could not undo that change.'));
  }
  return true;
};

/** Undoes the most recent change in a workspace, answering whether there was one. */
export const undoLast = (workspaceId: string): Promise<boolean> => {
  const entry = lastUndo(workspaceId);
  return entry === undefined ? Promise.resolve(false) : runUndo(entry.id);
};

/**
 * Records a change and raises its notice with an Undo button, answering the
 * entry's id. A newer change's notice replaces the last one's, so at most one
 * Undo button is on screen while every change stays reachable by Ctrl+Z.
 */
export const pushUndo = (
  workspaceId: string,
  message: string,
  revert: () => Promise<void>
): number => {
  const id = nextId;
  nextId += 1;
  for (const held of [...toastIds.keys()]) dropToast(held);
  entries = [...entries, { id, workspaceId, message, revert }];
  for (const dropped of entries.slice(0, -UNDO_LIMIT)) dropToast(dropped.id);
  entries = entries.slice(-UNDO_LIMIT);
  toastIds.set(
    id,
    showToast(message, 'info', {
      action: {
        label: UNDO_LABEL,
        run: () => {
          void runUndo(id);
        },
      },
      timeoutMs: UNDO_TOAST_MS,
    })
  );
  emit();
  return id;
};

/** Forgets every change. Used between tests so one does not leak into another. */
export const clearUndo = (): void => {
  for (const id of [...toastIds.keys()]) dropToast(id);
  entries = [];
  emit();
};
