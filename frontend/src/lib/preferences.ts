/**
 * The signed in person's interface preferences, held where any part of the
 * interface can read them without a hook: the people labels, the date
 * shortcuts, the timeline and copying a git branch name are plain functions
 * called from many places.
 *
 * The account row is the source of truth, so the choices follow the person to
 * every device. The auth provider copies them in here whenever the profile
 * loads or changes. The text size is also kept in this browser, because the
 * pre-paint script in index.html applies it before the bundle loads, the way
 * it does the theme, so the first frame is already the right size.
 */

import { useSyncExternalStore } from 'react';
import { workspacePath } from './paths';
import type { FontSize, HomeView, NameDisplay, WeekStart } from '../types/Api';

/** The preferences the interface reads outside any component. */
export interface InterfacePreferences {
  homeView: HomeView;
  weekStart: WeekStart;
  nameDisplay: NameDisplay;
  fontSize: FontSize;
  /** Whether buttons, menu items, rows and other interactive elements show the pointer cursor. */
  pointerCursors: boolean;
  /** Whether the editor turns typed emoticons such as `:)` into emoji. */
  convertEmoticons: boolean;
  /** Whether an issue the person creates starts assigned to them. */
  autoAssignToSelf: boolean;
  /** Whether copying a git branch name moves a not yet started issue to the team's first started status. */
  branchCopyStarts: boolean;
  /** Whether copying a git branch name assigns an unassigned, not yet started issue to the person. */
  branchCopyAssigns: boolean;
}

/** What a profile with nothing stored reads as, matching the server defaults. */
export const DEFAULT_PREFERENCES: InterfacePreferences = {
  homeView: 'home',
  weekStart: 'monday',
  nameDisplay: 'username',
  fontSize: 'default',
  pointerCursors: false,
  convertEmoticons: true,
  autoAssignToSelf: false,
  branchCopyStarts: true,
  branchCopyAssigns: true,
};

/** The storage key the pre-paint script in index.html reads too. */
export const FONT_SIZE_STORAGE_KEY = 'standupless-font-size';

/** The day number `Date.getDay` gives each week start. */
const WEEK_START_DAY: Record<WeekStart, number> = {
  sunday: 0,
  monday: 1,
  saturday: 6,
};

let current: InterfacePreferences = DEFAULT_PREFERENCES;

/** Everyone who wants to hear when a preference changes. */
const listeners = new Set<() => void>();

/** Subscribes to preference changes, returning the unsubscribe function. */
export const subscribePreferences = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The preferences in force right now. */
export const readPreferences = (): InterfacePreferences => current;

/**
 * Sets the document attribute the stylesheet scales the text tokens by, and
 * remembers it for the next pre-paint, ignoring a storage that refuses.
 */
export const paintFontSize = (size: FontSize): void => {
  const root = globalThis.document.documentElement;
  if (size === 'default') {
    root.removeAttribute('data-font-size');
  } else {
    root.setAttribute('data-font-size', size);
  }
  try {
    globalThis.localStorage.setItem(FONT_SIZE_STORAGE_KEY, size);
  } catch {
    return;
  }
};

/** Sets the document attribute the stylesheet shows pointer cursors under. */
export const paintPointerCursors = (on: boolean): void => {
  const root = globalThis.document.documentElement;
  if (on) {
    root.setAttribute('data-pointer-cursors', '');
  } else {
    root.removeAttribute('data-pointer-cursors');
  }
};

/** The preference fields a profile may carry, any of them missing. */
export interface StoredPreferences {
  home_view?: HomeView | undefined;
  week_start?: WeekStart | undefined;
  name_display?: NameDisplay | undefined;
  font_size?: FontSize | undefined;
  pointer_cursors?: boolean | undefined;
  convert_emoticons?: boolean | undefined;
  auto_assign_to_self?: boolean | undefined;
  branch_copy_starts?: boolean | undefined;
  branch_copy_assigns?: boolean | undefined;
}

/** The preferences a profile carries, with the defaults for any it leaves out. */
export const preferencesOf = (
  user: StoredPreferences | null
): InterfacePreferences => ({
  homeView: user?.home_view ?? DEFAULT_PREFERENCES.homeView,
  weekStart: user?.week_start ?? DEFAULT_PREFERENCES.weekStart,
  nameDisplay: user?.name_display ?? DEFAULT_PREFERENCES.nameDisplay,
  fontSize: user?.font_size ?? DEFAULT_PREFERENCES.fontSize,
  pointerCursors: user?.pointer_cursors ?? DEFAULT_PREFERENCES.pointerCursors,
  convertEmoticons:
    user?.convert_emoticons ?? DEFAULT_PREFERENCES.convertEmoticons,
  autoAssignToSelf:
    user?.auto_assign_to_self ?? DEFAULT_PREFERENCES.autoAssignToSelf,
  branchCopyStarts:
    user?.branch_copy_starts ?? DEFAULT_PREFERENCES.branchCopyStarts,
  branchCopyAssigns:
    user?.branch_copy_assigns ?? DEFAULT_PREFERENCES.branchCopyAssigns,
});

/**
 * Takes the preferences in force and tells the subscribers, repainting the
 * text size and the cursors when they moved. Unchanged values are a no-op, so a re-read of the
 * same profile never re-renders anything.
 */
export const setPreferences = (next: InterfacePreferences): void => {
  const keys = Object.keys(next) as (keyof InterfacePreferences)[];
  if (keys.every((key) => next[key] === current[key])) return;
  const resized = next.fontSize !== current.fontSize;
  const recursored = next.pointerCursors !== current.pointerCursors;
  current = next;
  if (resized) paintFontSize(next.fontSize);
  if (recursored) paintPointerCursors(next.pointerCursors);
  for (const listener of [...listeners]) listener();
};

/** Reads the preferences and re-renders whenever one changes. */
export const usePreferences = (): InterfacePreferences =>
  useSyncExternalStore(subscribePreferences, readPreferences, readPreferences);

/** The `Date.getDay` number the person's week starts on. */
export const weekStartDay = (): number => WEEK_START_DAY[current.weekStart];

/** Whether people should read by their full name rather than their username. */
export const prefersFullNames = (): boolean =>
  current.nameDisplay === 'full_name';

/** The page under a workspace each home view opens, relative to its base. */
const HOME_VIEW_SUFFIX: Record<HomeView, string> = {
  home: '',
  inbox: '/inbox',
  my_issues: '/issues',
  projects: '/projects',
  pulse: '/pulse',
  views: '/views',
};

/** The path a workspace opens on for the person's home view. */
export const homeViewPath = (
  slug: string,
  view: HomeView = current.homeView
): string => `${workspacePath(slug)}${HOME_VIEW_SUFFIX[view]}`;
