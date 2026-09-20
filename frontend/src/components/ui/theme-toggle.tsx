/**
 * The button that cycles the colour theme between following the system,
 * light and dark.
 */

import React, { useState } from 'react';
import { LuMonitor, LuMoon, LuSun } from 'react-icons/lu';
import { applyTheme, nextTheme, readTheme, themeLabel } from '../../lib/theme';
import { IconButton, type ButtonSize } from './button';

/** Props for ThemeToggle: the button size. */
export interface ThemeToggleProps {
  size?: ButtonSize;
}

/** An icon button showing the current theme; pressing it moves to the next. */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ size = 'sm' }) => {
  const [theme, setTheme] = useState(readTheme);
  const Icon =
    theme === 'light' ? LuSun : theme === 'dark' ? LuMoon : LuMonitor;
  return (
    <IconButton
      label={themeLabel(theme)}
      size={size}
      onClick={() => {
        const next = nextTheme(theme);
        applyTheme(next);
        setTheme(next);
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </IconButton>
  );
};

export default ThemeToggle;
