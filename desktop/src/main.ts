/**
 * The main process: one window on the hosted web app, a single instance, the
 * deep-link protocol, the navigation allowlist, the badge, native
 * notifications and auto-update. The web app is never bundled, so the desktop
 * app always runs whatever the web release is serving.
 */

import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  type IpcMainEvent,
  ipcMain,
  type WebContents,
} from 'electron';
import { resolveEnvironment, type Environment } from './environment';
import { CHANNELS, parseBadge, parseNotify, parseTheme } from './ipc';
import { installMenu } from './menu';
import {
  decideNavigation,
  deepLinkFromArgv,
  deepLinkToAppUrl,
  isAppPath,
  isAppUrl,
  isExternalUrl,
  nextSigningIn,
} from './navigation';
import { startUpdater } from './updater';
import { loadWindowState, trackWindowState } from './windowState';

/** The permissions the app origin may hold; every other request is refused. */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'notifications',
  'clipboard-sanitized-write',
  'clipboard-read',
  'fullscreen',
]);

/** The background each theme paints before the page loads. */
const BACKGROUND = { dark: '#141518', light: '#ffffff' } as const;

const env: Environment = resolveEnvironment(app.getAppPath(), app.isPackaged);

if (env.name === 'staging') {
  app.setName('Standupless Staging');
}

let mainWindow: BrowserWindow | null = null;
let pendingUrl: string | null = deepLinkFromArgv(process.argv, env);
let signingIn = false;
const navigateReady = new Set<number>();

/** Opens a URL in the default browser when it is a web or mail link. */
const openExternal = (url: string): void => {
  if (isExternalUrl(url)) void shell.openExternal(url);
};

/** Shows and focuses the main window, restoring it from the dock or taskbar. */
const focusMain = (): void => {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

/**
 * Opens an app URL in the main window. A page that listens for navigation
 * routes client side, so the session and open state survive; otherwise the
 * window loads the URL.
 */
const openInApp = (url: string): void => {
  if (mainWindow === null) {
    pendingUrl = url;
    return;
  }
  focusMain();
  const contents = mainWindow.webContents;
  const target = new URL(url);
  const path = `${target.pathname}${target.search}${target.hash}`;
  if (navigateReady.has(contents.id) && isAppUrl(contents.getURL(), env)) {
    contents.send(CHANNELS.navigate, path);
  } else {
    void contents.loadURL(url);
  }
};

/** Handles a deep link from the protocol, a second instance or `open-url`. */
const handleDeepLink = (link: string): void => {
  const target = deepLinkToAppUrl(link, env);
  if (target !== null) openInApp(target);
};

/** Whether an IPC message came from the main window showing the app origin. */
const fromApp = (event: IpcMainEvent): boolean =>
  mainWindow !== null &&
  event.sender === mainWindow.webContents &&
  isAppUrl(event.senderFrame?.url ?? '', env);

/** Applies the navigation allowlist to a page's top-level navigations. */
const guardNavigation = (contents: WebContents): void => {
  const decide = (
    event: { preventDefault: () => void },
    url: string,
    isMainFrame: boolean
  ): void => {
    if (!isMainFrame) return;
    const decision = decideNavigation(url, env, signingIn);
    if (decision === 'allow') {
      signingIn = nextSigningIn(url, env, signingIn);
      return;
    }
    event.preventDefault();
    if (decision === 'external') openExternal(url);
  };
  contents.on('will-navigate', (event) => {
    decide(event, event.url, event.isMainFrame);
  });
  contents.on('will-redirect', (event) => {
    decide(event, event.url, event.isMainFrame);
  });
  contents.on('did-navigate', () => {
    navigateReady.delete(contents.id);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url, env)) {
      openInApp(url);
    } else {
      openExternal(url);
    }
    return { action: 'deny' };
  });
};

/** Creates the one main window and loads the app. */
const createWindow = (): void => {
  const state = loadWindowState();
  const mac = process.platform === 'darwin';
  const window = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: app.name,
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? BACKGROUND.dark
      : BACKGROUND.light,
    autoHideMenuBar: !mac,
    ...(mac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 14 },
        }
      : {}),
    ...(process.platform === 'linux'
      ? { icon: join(__dirname, '..', 'resources', 'icon.png') }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      additionalArguments: [`--standupless-version=${app.getVersion()}`],
    },
  });
  mainWindow = window;
  if (state.maximized) window.maximize();
  trackWindowState(window);
  guardNavigation(window.webContents);

  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    navigateReady.delete(window.webContents.id);
    mainWindow = null;
  });

  const start = pendingUrl ?? env.appOrigin;
  pendingUrl = null;
  void window.loadURL(start);
};

/** Restricts permissions to the app origin and the short allowed list. */
const restrictPermissions = (): void => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      callback(
        ALLOWED_PERMISSIONS.has(permission) &&
          isAppUrl(details.requestingUrl, env)
      );
    }
  );
  ses.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && requestingOrigin === env.appOrigin
  );
};

/** Answers the bridge's badge, notification, theme and navigation messages. */
const listen = (): void => {
  ipcMain.on(CHANNELS.badge, (event, raw: unknown) => {
    const badge = parseBadge(raw);
    if (badge === null || !fromApp(event) || mainWindow === null) return;
    if (process.platform === 'win32') {
      mainWindow.setOverlayIcon(
        badge.count > 0 && badge.overlay !== null
          ? nativeImage.createFromDataURL(badge.overlay)
          : null,
        badge.count > 0 ? `${badge.count} unread` : ''
      );
      return;
    }
    app.setBadgeCount(badge.count);
  });

  ipcMain.on(CHANNELS.notify, (event, raw: unknown) => {
    const payload = parseNotify(raw);
    if (payload === null || !fromApp(event) || !Notification.isSupported()) {
      return;
    }
    const notification = new Notification({
      title: payload.title,
      body: payload.body,
      silent: false,
    });
    notification.on('click', () => {
      if (isAppPath(payload.path)) {
        openInApp(new URL(payload.path, env.appOrigin).toString());
      } else {
        focusMain();
      }
    });
    notification.show();
  });

  ipcMain.on(CHANNELS.theme, (event, raw: unknown) => {
    const theme = parseTheme(raw);
    if (theme === null || !fromApp(event)) return;
    nativeTheme.themeSource = theme;
    mainWindow?.setBackgroundColor(
      nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
    );
  });

  ipcMain.on(CHANNELS.navigateReady, (event, ready: unknown) => {
    if (!fromApp(event)) return;
    if (ready === true) {
      navigateReady.add(event.sender.id);
    } else {
      navigateReady.delete(event.sender.id);
    }
  });
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.defaultApp && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(env.scheme, process.execPath, [
      join(process.cwd(), process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(env.scheme);
  }

  app.on('second-instance', (_event, argv) => {
    const target = deepLinkFromArgv(argv, env);
    if (target !== null) {
      openInApp(target);
    } else {
      focusMain();
    }
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });

  void app.whenReady().then(() => {
    restrictPermissions();
    listen();
    const checkForUpdates = startUpdater(env);
    installMenu({ env, mainWindow: () => mainWindow, checkForUpdates });
    createWindow();

    app.on('activate', () => {
      if (mainWindow === null) {
        createWindow();
      } else {
        focusMain();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
