/**
 * Remembers the main window's size, position and maximized state between
 * launches, in a small JSON file in the user data directory.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen, type BrowserWindow, type Rectangle } from 'electron';

/** What is kept between launches. */
export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

/** The size a first launch opens at. */
const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 820 };

/** How long a resize or move settles before it is written. */
const SAVE_DELAY_MS = 500;

/** The file the state lives in. */
const statePath = (): string =>
  join(app.getPath('userData'), 'window-state.json');

/** Whether a rectangle overlaps any display, so a window never opens offscreen. */
const isVisible = (bounds: Rectangle): boolean =>
  screen.getAllDisplays().some(({ workArea }) => {
    const right = Math.min(
      bounds.x + bounds.width,
      workArea.x + workArea.width
    );
    const bottom = Math.min(
      bounds.y + bounds.height,
      workArea.y + workArea.height
    );
    return (
      right - Math.max(bounds.x, workArea.x) >= 100 &&
      bottom - Math.max(bounds.y, workArea.y) >= 50
    );
  });

/** Whether a parsed value has the shape of a saved state. */
const isWindowState = (value: unknown): value is WindowState => {
  if (typeof value !== 'object' || value === null) return false;
  const { bounds, maximized } = value as Partial<WindowState>;
  return (
    typeof maximized === 'boolean' &&
    typeof bounds === 'object' &&
    ['x', 'y', 'width', 'height'].every(
      (key) =>
        typeof (bounds as unknown as Record<string, unknown>)[key] === 'number'
    )
  );
};

/** Reads the saved state, or a centred default when there is none to trust. */
export const loadWindowState = (): WindowState => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (isWindowState(parsed) && isVisible(parsed.bounds)) return parsed;
  } catch {
    return centred();
  }
  return centred();
};

/** A default-sized window centred on the primary display. */
const centred = (): WindowState => {
  const { workArea } = screen.getPrimaryDisplay();
  const width = Math.min(DEFAULT_BOUNDS.width, workArea.width);
  const height = Math.min(DEFAULT_BOUNDS.height, workArea.height);
  return {
    bounds: {
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      width,
      height,
    },
    maximized: false,
  };
};

/** Writes the window's state, ignoring a failed write. */
const save = (window: BrowserWindow): void => {
  if (window.isDestroyed()) return;
  const state: WindowState = {
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
  };
  try {
    writeFileSync(statePath(), JSON.stringify(state));
  } catch {
    return;
  }
};

/** Saves the window's state whenever it settles and when it closes. */
export const trackWindowState = (window: BrowserWindow): void => {
  let timer: NodeJS.Timeout | undefined;
  const schedule = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => save(window), SAVE_DELAY_MS);
  };
  window.on('resize', schedule);
  window.on('move', schedule);
  window.on('maximize', schedule);
  window.on('unmaximize', schedule);
  window.on('close', () => {
    clearTimeout(timer);
    save(window);
  });
};
