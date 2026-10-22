/**
 * The signed in person's interface preferences, held where any part of the
 * interface can read them without a hook: the people labels, the date
 * shortcuts and the timeline are plain functions called from many places.
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
}

/** What a profile with nothing stored reads as, matching the server defaults. */
export const DEFAULT_PREFERENCES: InterfacePreferences = {
  homeView: 'home',
  weekStart: 'monday',
  nameDisplay: 'username',
  fontSize: 'default',
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

/** The preference fields a profile may carry, any of them missing. */
export interface StoredPreferences {
  home_view?: HomeView | undefined;
  week_start?: WeekStart | undefined;
  name_display?: NameDisplay | undefined;
  font_size?: FontSize | undefined;
}

/** The preferences a profile carries, with the defaults for any it leaves out. */
export const preferencesOf = (
  user: StoredPreferences | null
): InterfacePreferences => ({
  homeView: user?.home_view ?? DEFAULT_PREFERENCES.homeView,
  weekStart: user?.week_start ?? DEFAULT_PREFERENCES.weekStart,
  nameDisplay: user?.name_display ?? DEFAULT_PREFERENCES.nameDisplay,
  fontSize: user?.font_size ?? DEFAULT_PREFERENCES.fontSize,
});

/**
 * Takes the preferences in force and tells the subscribers, repainting the
 * text size when it moved. Unchanged values are a no-op, so a re-read of the
 * same profile never re-renders anything.
 */
export const setPreferences = (next: InterfacePreferences): void => {
  if (
    next.homeView === current.homeView &&
    next.weekStart === current.weekStart &&
    next.nameDisplay === current.nameDisplay &&
    next.fontSize === current.fontSize
  ) {
    return;
  }
  const resized = next.fontSize !== current.fontSize;
  current = next;
  if (resized) paintFontSize(next.fontSize);
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
