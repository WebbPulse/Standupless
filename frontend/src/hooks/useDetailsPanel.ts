/**
 * Whether the issue details panel is shown, as Linear's Cmd or Ctrl+I
 * toggles it. The choice belongs to the viewer and follows them across issues,
 * the inbox's reading pane and reloads, so it lives in local storage with an
 * in-memory copy for when storage is missing or refuses the write. Every
 * mounted view reads the same value and hears the same change.
 */

import { useSyncExternalStore } from 'react';
import { displayKeys } from './useShortcuts';

/** The local storage key holding the choice. */
export const DETAILS_PANEL_STORAGE_KEY = 'standupless.issueDetailsPanel';

/** The keys that show and hide the panel, Linear's own. */
export const DETAILS_PANEL_KEYS = 'mod+i';

/** The stored value for a hidden panel. Anything else reads as shown. */
const HIDDEN = 'hidden';

let held: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether the panel is shown, from storage, else the held copy, else shown. */
export const readDetailsPanelShown = (): boolean => {
  try {
    const raw = globalThis.localStorage.getItem(DETAILS_PANEL_STORAGE_KEY);
    if (raw !== null) return raw !== HIDDEN;
  } catch {
    return held ?? true;
  }
  return held ?? true;
};

/** Writes the choice to storage, ignoring a refused write. */
const writeChoice = (shown: boolean): void => {
  try {
    if (shown) globalThis.localStorage.removeItem(DETAILS_PANEL_STORAGE_KEY);
    else globalThis.localStorage.setItem(DETAILS_PANEL_STORAGE_KEY, HIDDEN);
  } catch {
    return;
  }
};

/** Remembers whether the panel is shown and tells every view. */
export const setDetailsPanelShown = (shown: boolean): void => {
  held = shown;
  writeChoice(shown);
  for (const listener of listeners) listener();
};

/** Forgets the choice, for tests. */
export const resetDetailsPanel = (): void => {
  held = null;
  try {
    globalThis.localStorage.removeItem(DETAILS_PANEL_STORAGE_KEY);
  } catch {
    return;
  }
};

/** Listens for the choice changing here or in another tab. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === DETAILS_PANEL_STORAGE_KEY || event.key === null) {
      listener();
    }
  };
  globalThis.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener('storage', onStorage);
  };
};

/** The label for the action that flips the panel from its current state. */
export const detailsPanelLabel = (shown: boolean): string =>
  shown ? 'Hide details panel' : 'Show details panel';

/** The toggle's tooltip, the action with its keys. */
export const detailsPanelTitle = (shown: boolean): string =>
  `${detailsPanelLabel(shown)} (${displayKeys(DETAILS_PANEL_KEYS)[0] ?? ''})`;

/** What useDetailsPanel returns. */
export interface DetailsPanel {
  shown: boolean;
  toggle: () => void;
}

/** The viewer's details panel choice and a toggle for it. */
export const useDetailsPanel = (): DetailsPanel => {
  const shown = useSyncExternalStore(
    subscribe,
    readDetailsPanelShown,
    () => true
  );
  return {
    shown,
    toggle: () => {
      setDetailsPanelShown(!readDetailsPanelShown());
    },
  };
};

export default useDetailsPanel;
