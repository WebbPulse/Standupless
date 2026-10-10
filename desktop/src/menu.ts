/**
 * The native application menu. Standard roles give every platform its usual
 * edit, view and window shortcuts, and the Go and Help menus add the few
 * actions a browser chrome would otherwise provide.
 */

import {
  app,
  Menu,
  shell,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from 'electron';
import { DOWNLOADS_URL, type Environment } from './environment';

/** What the menu needs from the rest of the shell. */
export interface MenuActions {
  env: Environment;
  mainWindow: () => BrowserWindow | null;
  checkForUpdates: () => void;
}

/** Runs `action` on the main window's contents when there is a window. */
const onContents =
  (
    actions: MenuActions,
    action: (contents: Electron.WebContents) => void
  ): (() => void) =>
  () => {
    const window = actions.mainWindow();
    if (window !== null && !window.isDestroyed()) action(window.webContents);
  };

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
      submenu: [mac ? { role: 'close' } : { role: 'quit' }],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
        {
          label: 'Open in Browser',
          click: onContents(actions, (contents) => {
            void shell.openExternal(contents.getURL());
          }),
        },
      ],
    },
    { role: 'windowMenu' },
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
            void shell.openExternal(DOWNLOADS_URL);
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
