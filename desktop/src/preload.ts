/**
 * The minimal bridge the hosted page sees as `window.standuplessDesktop`. It
 * runs sandboxed with context isolation, so it may only require `electron`:
 * the channel names are repeated here rather than imported, and must match
 * `CHANNELS` in ipc.ts. Every call is fire and forget, and the main process
 * validates each payload before acting on it.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { NotifyPayload, ThemeSource } from './ipc';

const BADGE = 'standupless:badge';
const NOTIFY = 'standupless:notify';
const THEME = 'standupless:theme';
const NAVIGATE = 'standupless:navigate';
const NAVIGATE_READY = 'standupless:navigate-ready';

/** The prefix the main process passes the app version under. */
const VERSION_ARG = '--standupless-version=';

/** The app version, from the argument the main process added. */
const version =
  process.argv
    .find((arg) => arg.startsWith(VERSION_ARG))
    ?.slice(VERSION_ARG.length) ?? '';

/**
 * Draws the Windows taskbar overlay for a count, since Windows has no numeric
 * badge. Returns null for zero, which clears the overlay.
 */
const drawOverlay = (count: number): string | null => {
  if (count <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.fillStyle = '#e5484d';
  context.beginPath();
  context.arc(16, 16, 16, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#ffffff';
  context.font = `bold ${count > 9 ? 16 : 20}px sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(count > 99 ? '99+' : String(count), 16, 17);
  return canvas.toDataURL('image/png');
};

contextBridge.exposeInMainWorld(
  'standuplessDesktop',
  Object.freeze({
    platform: process.platform,
    version,
    passkeys: process.platform === 'win32',
    setBadgeCount(count: number): void {
      ipcRenderer.send(BADGE, {
        count,
        overlay: process.platform === 'win32' ? drawOverlay(count) : null,
      });
    },
    notify(payload: NotifyPayload): void {
      ipcRenderer.send(NOTIFY, payload);
    },
    setTheme(theme: ThemeSource): void {
      ipcRenderer.send(THEME, theme);
    },
    onNavigate(listener: (path: string) => void): () => void {
      const handler = (_event: IpcRendererEvent, path: unknown): void => {
        if (typeof path === 'string') listener(path);
      };
      ipcRenderer.on(NAVIGATE, handler);
      ipcRenderer.send(NAVIGATE_READY, true);
      return () => {
        ipcRenderer.removeListener(NAVIGATE, handler);
        ipcRenderer.send(NAVIGATE_READY, false);
      };
    },
  })
);
