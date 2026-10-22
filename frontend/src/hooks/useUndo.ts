/**
 * The undo history as React state, so Ctrl+Z and the command palette offer
 * undo only while the workspace has a change to put back.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { canUndo, subscribeUndo, undoLast } from '../lib/undo';

/** The keys that undo the last issue change: Ctrl+Z, or Cmd+Z on a Mac. */
export const UNDO_KEYS = 'mod+z';

/** The command's name, in the shortcut list and the palette. */
export const UNDO_LABEL = 'Undo last change';

/** What {@link useUndo} hands back. */
export interface UndoControls {
  /** Whether the workspace has a change to undo. */
  canUndo: boolean;
  /** Undoes the workspace's most recent change. */
  undo: () => void;
}

/** Whether a workspace has a change to undo, and the way to undo it. */
export const useUndo = (workspaceId: string): UndoControls => {
  const available = useSyncExternalStore(subscribeUndo, () =>
    canUndo(workspaceId)
  );
  const undo = useCallback(() => {
    void undoLast(workspaceId);
  }, [workspaceId]);
  return { canUndo: available, undo };
};

export default useUndo;
