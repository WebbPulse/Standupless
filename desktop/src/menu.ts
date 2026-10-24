/**
 * The native application menu. Standard roles give every platform its usual
 * edit and window shortcuts, the File and Go menus carry the tab actions, and
 * the View, Go and Help menus add the few actions a browser chrome would
 * otherwise provide, each acting on the active tab. The tab shortcuts are
 * shown here but caught before the page sees them, so the menu only draws
 * them rather than registering them.
 */

import {
  app,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { downloadsUrl, type Environment } from './environment';
import type { TabManager } from './tabs';
import type { TabShortcut } from './tabsModel';

/** What the menu needs from the rest of the shell. */
export interface MenuActions {
  env: Environment;
  mainWindow: () => BrowserWindow | null;
  tabs: () => TabManager | null;
  checkForUpdates: () => void;
}

/** How far one zoom step goes. */
const ZOOM_STEP = 0.5;

/** Runs `action` on the active tab's contents when there is one. */
const onContents =
  (
    actions: MenuActions,
    action: (contents: Electron.WebContents) => void
  ): (() => void) =>
  () => {
    const contents = actions.tabs()?.activeContents() ?? null;
    if (contents !== null && !contents.isDestroyed()) action(contents);
  };

/** A menu item for a tab shortcut, drawn but left to the tabs to catch. */
const tabItem = (
  actions: MenuActions,
  label: string,
  accelerator: string,
  shortcut: TabShortcut
): MenuItemConstructorOptions => ({
  label,
  accelerator,
  registerAccelerator: false,
  click: () => actions.tabs()?.run(shortcut),
});

/** Builds and installs the application menu. */
export const installMenu = (actions: MenuActions): void => {
  const mac = process.platform === 'darwin';
  const { env } = actions;

  const appMenu: MenuItemConstructorOptions[] = mac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            {
              label: 'Check for Updates...',
              click: actions.checkForUpdates,
              visible: env.autoUpdate,
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        tabItem(actions, 'New Tab', 'CmdOrCtrl+T', { type: 'new' }),
        tabItem(actions, 'Reopen Closed Tab', 'CmdOrCtrl+Shift+T', {
          type: 'reopen',
        }),
        { type: 'separator' },
        tabItem(actions, 'Close Tab', 'CmdOrCtrl+W', { type: 'close' }),
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            const window = actions.mainWindow();
            if (window !== null && !window.isDestroyed()) window.close();
          },
        },
        ...(mac
          ? []
          : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: onContents(actions, (contents) => contents.reload()),
        },
        {
          label: 'Force Reload',
          accelerator: 'Shift+CmdOrCtrl+R',
          click: onContents(actions, (contents) =>
            contents.reloadIgnoringCache()
          ),
        },
        {
          label: 'Toggle Developer Tools',
          accelerator: mac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          click: onContents(actions, (contents) => contents.toggleDevTools()),
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: onContents(actions, (contents) => contents.setZoomLevel(0)),
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: onContents(actions, (contents) =>
            contents.setZoomLevel(contents.getZoomLevel() + ZOOM_STEP)
          ),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: onContents(actions, (contents) =>
            contents.setZoomLevel(contents.getZoomLevel() - ZOOM_STEP)
          ),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: onContents(actions, (contents) => {
            if (contents.navigationHistory.canGoBack()) {
              contents.navigationHistory.goBack();
            }
          }),
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: onContents(actions, (contents) => {
            if (contents.navigationHistory.canGoForward()) {
              contents.navigationHistory.goForward();
            }
          }),
        },
        { type: 'separator' },
        tabItem(actions, 'Next Tab', 'Ctrl+Tab', { type: 'cycle', delta: 1 }),
        tabItem(actions, 'Previous Tab', 'Ctrl+Shift+Tab', {
          type: 'cycle',
          delta: -1,
        }),
        { type: 'separator' },
        {
          label: 'Open in Browser',
          click: onContents(actions, (contents) => {
            void shell.openExternal(contents.getURL());
          }),
        },
      ],
    },
    mac
      ? { role: 'windowMenu' }
      : { label: 'Window', submenu: [{ role: 'minimize' }] },
    {
      role: 'help',
      submenu: [
        {
          label: 'Standupless Website',
          click: () => {
            void shell.openExternal(env.appOrigin);
          },
        },
        {
          label: 'Download Desktop Apps',
          click: () => {
            void shell.openExternal(downloadsUrl(env));
          },
        },
        {
          label: 'Check for Updates...',
          click: actions.checkForUpdates,
          visible: !mac && env.autoUpdate,
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};
