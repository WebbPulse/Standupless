/**
 * Selection on the projects list and board, worked the way the issue list's
 * is: x toggles the project in focus, Shift and an arrow or j and k extends
 * the selection from it, Cmd or Ctrl and A takes every project shown, Escape
 * lets go, and a Shift click takes the run from the last project picked.
 * Selected projects that leave the page drop out of the selection.
 */

import { useCallback, useMemo, useState } from 'react';
import { useShortcut } from './useShortcuts';

/** Options for {@link useProjectSelection}. */
export interface ProjectSelectionOptions {
  /** The projects shown, by id, in the order the keys walk them. */
  order: readonly string[];
  /** The project in focus, or null when none is. */
  focusedId: string | null;
  /** Moves the focus to a project, as extending the selection does. */
  onFocus: (projectId: string) => void;
  /** False while a dialog or another surface owns the keyboard. */
  enabled?: boolean;
}

/** What {@link useProjectSelection} hands back. */
export interface ProjectSelection {
  /** The selected projects that are still shown. */
  selected: ReadonlySet<string>;
  /** Picks or drops one project, or takes the run from the anchor with `range`. */
  toggle: (projectId: string, range: boolean) => void;
  clear: () => void;
}

/** Holds and keys the projects page's selection. */
export const useProjectSelection = ({
  order,
  focusedId,
  onFocus,
  enabled = true,
}: ProjectSelectionOptions): ProjectSelection => {
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const selected = useMemo(() => {
    const shown = new Set(order);
    return new Set([...held].filter((id) => shown.has(id)));
  }, [held, order]);

  const toggle = useCallback(
    (projectId: string, range: boolean) => {
      if (range && anchor !== null && order.includes(anchor)) {
        const from = order.indexOf(anchor);
        const to = order.indexOf(projectId);
        const span = order.slice(Math.min(from, to), Math.max(from, to) + 1);
        setHeld((current) => new Set([...current, ...span]));
        return;
      }
      setHeld((current) => {
        const next = new Set(current);
        if (next.has(projectId)) next.delete(projectId);
        else next.add(projectId);
        return next;
      });
      setAnchor(projectId);
    },
    [anchor, order]
  );

  const clear = useCallback(() => {
    setHeld(new Set());
    setAnchor(null);
  }, []);

  const extend = (step: number): void => {
    if (order.length === 0) return;
    const at = focusedId === null ? -1 : order.indexOf(focusedId);
    const nextIndex =
      at < 0
        ? step > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + step));
    const next = order[nextIndex];
    if (next === undefined) return;
    const start = at < 0 ? next : (order[at] ?? next);
    setHeld((current) => new Set([...current, start, next]));
    if (anchor === null) setAnchor(start);
    onFocus(next);
  };

  const live = enabled && order.length > 0;
  useShortcut({
    keys: 'x',
    label: 'Select project',
    group: 'List',
    enabled: live && focusedId !== null,
    handler: () => {
      if (focusedId !== null) toggle(focusedId, false);
    },
  });
  useShortcut({
    keys: 'shift+arrowdown',
    label: 'Extend selection down',
    group: 'List',
    enabled: live,
    handler: () => {
      extend(1);
    },
  });
  useShortcut({
    keys: 'shift+arrowup',
    label: 'Extend selection up',
    group: 'List',
    enabled: live,
    handler: () => {
      extend(-1);
    },
  });
  useShortcut({
    keys: 'shift+j',
    label: 'Extend selection down',
    group: 'List',
    enabled: live,
    handler: () => {
      extend(1);
    },
  });
  useShortcut({
    keys: 'shift+k',
    label: 'Extend selection up',
    group: 'List',
    enabled: live,
    handler: () => {
      extend(-1);
    },
  });
  useShortcut({
    keys: 'mod+a',
    label: 'Select all',
    group: 'List',
    enabled: live,
    handler: (event) => {
      event?.preventDefault();
      setHeld(new Set(order));
    },
  });
  useShortcut({
    keys: 'escape',
    label: 'Clear selection',
    group: 'List',
    enabled: enabled && selected.size > 0,
    handler: clear,
  });

  return { selected, toggle, clear };
};

export default useProjectSelection;
