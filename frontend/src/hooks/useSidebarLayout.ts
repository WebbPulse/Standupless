/**
 * The desktop sidebar's layout: whether it is collapsed, as Linear's `[`
 * toggles it, and how wide the viewer dragged it. Both belong to the viewer
 * and survive reloads, so they live in local storage with an in-memory copy
 * for when storage is missing or refuses the write. The shell and the
 * shortcut layer read the same values and hear the same changes.
 */

import { useSyncExternalStore } from 'react';

/** The local storage key holding the collapsed choice. */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'standupless.sidebarCollapsed';

/** The local storage key holding the width in pixels. */
export const SIDEBAR_WIDTH_STORAGE_KEY = 'standupless.sidebarWidth';

/** The keys that collapse and expand the sidebar, Linear's own. */
export const SIDEBAR_TOGGLE_KEYS = '[';

/** The narrowest the sidebar can be dragged, in pixels. */
export const SIDEBAR_MIN_WIDTH = 200;

/** The widest the sidebar can be dragged, in pixels. */
export const SIDEBAR_MAX_WIDTH = 360;

/** The width before any drag and after a reset, matching `w-sidebar`. */
export const SIDEBAR_DEFAULT_WIDTH = 232;

/** The stored value for a collapsed sidebar. Anything else reads as expanded. */
const COLLAPSED = 'collapsed';

let heldCollapsed: boolean | null = null;
let heldWidth: number | null = null;
const listeners = new Set<() => void>();

/** Rounds a width and keeps it within the allowed range. */
export const clampSidebarWidth = (width: number): number => {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(width))
  );
};

/** Reads one stored value, or null when it is absent or storage refuses. */
const readStored = (key: string): string | null => {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Writes one value, removing it for null, ignoring a refused write. */
const writeStored = (key: string, value: string | null): void => {
  try {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, value);
  } catch {
    return;
  }
};

/** Whether the sidebar is collapsed, from storage, else the held copy. */
export const readSidebarCollapsed = (): boolean => {
  const raw = readStored(SIDEBAR_COLLAPSED_STORAGE_KEY);
  if (raw !== null) return raw === COLLAPSED;
  return heldCollapsed ?? false;
};

/** The sidebar's width, from storage, else the held copy, else the default. */
export const readSidebarWidth = (): number => {
  const raw = readStored(SIDEBAR_WIDTH_STORAGE_KEY);
  if (raw !== null) {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isNaN(parsed)) return clampSidebarWidth(parsed);
  }
  return heldWidth ?? SIDEBAR_DEFAULT_WIDTH;
};

/** Tells every mounted reader that a value changed. */
const notify = (): void => {
  for (const listener of listeners) listener();
};

/** Remembers whether the sidebar is collapsed and tells every reader. */
export const setSidebarCollapsed = (collapsed: boolean): void => {
  heldCollapsed = collapsed;
  writeStored(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? COLLAPSED : null);
  notify();
};

/** Flips the collapsed choice. */
export const toggleSidebarCollapsed = (): void => {
  setSidebarCollapsed(!readSidebarCollapsed());
};

/** Remembers a clamped width and tells every reader. */
export const setSidebarWidth = (width: number): void => {
  const next = clampSidebarWidth(width);
  heldWidth = next;
  writeStored(
    SIDEBAR_WIDTH_STORAGE_KEY,
    next === SIDEBAR_DEFAULT_WIDTH ? null : String(next)
  );
  notify();
};

/** Forgets both choices, for tests. */
export const resetSidebarLayout = (): void => {
  heldCollapsed = null;
  heldWidth = null;
  writeStored(SIDEBAR_COLLAPSED_STORAGE_KEY, null);
  writeStored(SIDEBAR_WIDTH_STORAGE_KEY, null);
};

/** Listens for either value changing here or in another tab. */
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (
      event.key === SIDEBAR_COLLAPSED_STORAGE_KEY ||
      event.key === SIDEBAR_WIDTH_STORAGE_KEY ||
      event.key === null
    ) {
      listener();
    }
  };
  globalThis.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener('storage', onStorage);
  };
};

/** What useSidebarLayout returns. */
export interface SidebarLayout {
  collapsed: boolean;
  width: number;
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  resetWidth: () => void;
}

/** The viewer's sidebar layout and the setters for it. */
export const useSidebarLayout = (): SidebarLayout => {
  const collapsed = useSyncExternalStore(
    subscribe,
    readSidebarCollapsed,
    () => false
  );
  const width = useSyncExternalStore(
    subscribe,
    readSidebarWidth,
    () => SIDEBAR_DEFAULT_WIDTH
  );
  return {
    collapsed,
    width,
    toggle: toggleSidebarCollapsed,
    setCollapsed: setSidebarCollapsed,
    setWidth: setSidebarWidth,
    resetWidth: () => {
      setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    },
  };
};

export default useSidebarLayout;
