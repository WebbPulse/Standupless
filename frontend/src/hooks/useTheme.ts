/**
 * The current colour theme as React state, shared by every control that shows
 * or changes it. It reads through `useSyncExternalStore` so the sidebar toggle
 * and the command palette stay in step when either one changes the theme.
 */

import { useCallback, useSyncExternalStore } from 'react';
import {
  applyTheme,
  readTheme,
  subscribeTheme,
  type Theme,
} from '../lib/theme';

/** What {@link useTheme} hands back. */
export interface ThemeState {
  /** The stored setting: dark, light or system. */
  theme: Theme;
  /** Applies and remembers a setting. */
  setTheme: (theme: Theme) => void;
}

/** Reads the theme setting and re-renders whenever it changes. */
export const useTheme = (): ThemeState => {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, readTheme);
  const setTheme = useCallback((next: Theme) => {
    applyTheme(next);
  }, []);
  return { theme, setTheme };
};

export default useTheme;
