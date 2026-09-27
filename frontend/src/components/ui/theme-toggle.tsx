/**
 * The button that cycles the colour theme between dark, light and following
 * the system. It reads the shared theme state, so a change made from the
 * command palette shows here at once.
 */

import React from 'react';
import { LuMonitor, LuMoon, LuSun } from 'react-icons/lu';
import { useTheme } from '../../hooks/useTheme';
import { nextTheme, themeLabel } from '../../lib/theme';
import { IconButton, type ButtonSize } from './button';

/** Props for ThemeToggle: the button size. */
export interface ThemeToggleProps {
  size?: ButtonSize;
}

/** An icon button showing the current theme; pressing it moves to the next. */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ size = 'sm' }) => {
  const { theme, setTheme } = useTheme();
  const Icon =
    theme === 'light' ? LuSun : theme === 'dark' ? LuMoon : LuMonitor;
  return (
    <IconButton
      label={themeLabel(theme)}
      size={size}
      onClick={() => {
        setTheme(nextTheme(theme));
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </IconButton>
  );
};

export default ThemeToggle;
