/**
 * The main process: one window of tabs on the hosted web app, a single
 * instance, the deep-link protocol, the navigation allowlist, the badge,
 * native notifications, sign-in through the system browser and auto-update.
 * The web app is never bundled, so the desktop app always runs whatever the
 * web release is serving.
 */

import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  type IpcMainEvent,
  ipcMain,
  type MenuItemConstructorOptions,
  type WebContents,
  type WebPreferences,
} from 'electron';
import { appImagePath, registerAppImageHandler } from './appImageProtocol';
import { resolveEnvironment, type Environment } from './environment';
import {
  completeBrowserSignIn,
  handoffFailedUrl,
  startBrowserSignIn,
} from './handoff';
import {
  CHANNELS,
  parseBadge,
  parseNotify,
  parseTabCommand,
  parseTheme,
  type BadgePayload,
} from './ipc';
import { installMenu } from './menu';
import {
  decideNavigation,
  deepLinkFromArgv,
  deepLinkToAppUrl,
  handoffCallbackFromArgv,
  isAppPath,
  isAppUrl,
  isExternalUrl,
  isHandoffCallback,
  nextSigningIn,
} from './navigation';
import { loadSavedTabs, TabManager } from './tabs';
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

/** How long the tabs wait for a sign-in or sign-out's cookies to settle. */
const SESSION_SETTLE_MS = 300;

/** How long a notification for the same page is not shown again. */
const NOTIFY_DEDUPE_MS = 10_000;

/** The cookie changes that replace a cookie rather than end the session. */
const REPLACING_CAUSES: ReadonlySet<string> = new Set([
  'overwrite',
  'expired-overwrite',
  'inserted',
  'inserted-no-change-overwrite',
  'inserted-no-value-change-overwrite',
]);

const env: Environment = resolveEnvironment(app.getAppPath(), app.isPackaged);

if (env.name === 'staging') {
  app.setName('Standupless Staging');
}

let mainWindow: BrowserWindow | null = null;
let tabs: TabManager | null = null;
let pendingUrl: string | null =
  handoffCallbackFromArgv(process.argv, env) === null
    ? deepLinkFromArgv(process.argv, env)
    : handoffFailedUrl(env, 'expired');
let signingIn = false;
const badges = new Map<number, BadgePayload>();
const recentNotifications = new Set<string>();

/** The webPreferences every tab shares; the default session keeps one sign-in. */
const TAB_PREFERENCES: WebPreferences = {
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
};

/** The background the current theme paints. */
const background = (): string =>
  nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;

/** Opens a URL in the default browser when it is a web or mail link. */
const openExternal = (url: string): void => {
  if (isExternalUrl(url)) void shell.openExternal(url);
};

/** Shows and focuses the main window, restoring it from the dock or taskbar. */
const focusMain = (): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
};

/**
 * Shows an app URL: focuses the tab already on that page, or opens a new tab
 * on it. With no window yet, the URL waits and the next window opens on it.
 */
const openInApp = (url: string): void => {
  if (tabs === null) {
    pendingUrl = url;
    if (app.isReady() && mainWindow === null) createWindow();
    return;
  }
  focusMain();
  tabs.focusOrOpen(url);
};

/**
 * Redeems a browser sign-in callback, then loads the page the outcome names
 * in the active tab. A full load rather than a client side route, so the page
 * starts over and picks up the session from the refresh cookie the exchange
 * set; the other tabs reload when that cookie arrives.
 */
const finishBrowserSignIn = (link: string): void => {
  focusMain();
  void completeBrowserSignIn(link, env).then((url) => {
    if (tabs === null) {
      pendingUrl = url;
    } else {
      tabs.loadInActive(url);
    }
  });
};

/**
 * Handles a deep link from the protocol, a second instance or `open-url`. A
 * sign-in handoff callback is redeemed here; anything else opens in a tab.
 * Returns whether the link was one this app handles.
 */
const handleDeepLink = (link: string): boolean => {
  if (isHandoffCallback(link, env)) {
    finishBrowserSignIn(link);
    return true;
  }
  const target = deepLinkToAppUrl(link, env);
  if (target === null) return false;
  openInApp(target);
  return true;
};

/** Whether an IPC message came from a tab showing the app origin. */
const fromApp = (event: IpcMainEvent): boolean =>
  tabs !== null &&
  tabs.owns(event.sender) &&
  isAppUrl(event.senderFrame?.url ?? '', env);

/** Whether an IPC message came from the window's own tab strip. */
const fromStrip = (event: IpcMainEvent): boolean =>
  mainWindow !== null &&
  !mainWindow.isDestroyed() &&
  event.sender === mainWindow.webContents;

/** Shows the highest unread count any tab reports. */
const applyBadge = (): void => {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  let top: BadgePayload = { count: 0, overlay: null };
  for (const badge of badges.values()) {
    if (badge.count > top.count) top = badge;
  }
  if (process.platform === 'win32') {
    mainWindow.setOverlayIcon(
      top.count > 0 && top.overlay !== null
        ? nativeImage.createFromDataURL(top.overlay)
        : null,
      top.count > 0 ? `${top.count} unread` : ''
    );
    return;
  }
  app.setBadgeCount(top.count);
};

/**
 * Shows the native menu for a right click the page left alone: open an app
 * link in a new tab, open any other link in the browser, copy a link, and the
 * usual spelling and editing items.
 */
const showContextMenu = (
  contents: WebContents,
  params: Electron.ContextMenuParams
): void => {
  const items: MenuItemConstructorOptions[] = [];
  const link = params.linkURL;
  if (link !== '') {
    if (isAppUrl(link, env)) {
      items.push({
        label: 'Open in New Tab',
        click: () => tabs?.open(link, { background: true }),
      });
    } else if (isExternalUrl(link)) {
      items.push({ label: 'Open in Browser', click: () => openExternal(link) });
    }
    items.push({ label: 'Copy Link', click: () => clipboard.writeText(link) });
  }
  if (params.isEditable) {
    if (items.length > 0) items.push({ type: 'separator' });
    const word = params.misspelledWord;
    if (word !== '') {
      const suggestions = params.dictionarySuggestions.slice(0, 5);
      for (const suggestion of suggestions) {
        items.push({
          label: suggestion,
          click: () => {
            if (!contents.isDestroyed())
              contents.replaceMisspelling(suggestion);
          },
        });
      }
      if (suggestions.length === 0) {
        items.push({ label: 'No Guesses Found', enabled: false });
      }
      items.push(
        {
          label: 'Add to Dictionary',
          click: () => {
            session.defaultSession.addWordToSpellCheckerDictionary(word);
          },
        },
        { type: 'separator' }
      );
    }
    items.push(
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    );
  } else if (params.selectionText.trim() !== '') {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ role: 'copy' });
  }
  if (items.length === 0) return;
  const menu = Menu.buildFromTemplate(items);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    menu.popup({ window: mainWindow });
  } else {
    menu.popup();
  }
};

/**
 * Applies the navigation allowlist to a tab's top-level navigations, and
 * routes the links a page opens: a Cmd/Ctrl or middle click on an app link
 * opens a background tab, any other app link opens or focuses a tab, and
 * everything else goes to the default browser.
 */
const setupTab = (contents: WebContents): void => {
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
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!isAppUrl(url, env)) {
      openExternal(url);
    } else if (disposition === 'background-tab') {
      tabs?.open(url, { background: true });
    } else if (disposition === 'foreground-tab') {
      tabs?.open(url, { background: false });
    } else {
      tabs?.focusOrOpen(url);
    }
    return { action: 'deny' };
  });
  contents.on('context-menu', (_event, params) => {
    showContextMenu(contents, params);
  });
};

/** Keeps the tab strip page on its own file, never navigating or opening. */
const lockStrip = (contents: WebContents): void => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
};

/** Creates the one window, draws its tab strip and restores the saved tabs. */
const createWindow = (): void => {
  const state = loadWindowState();
  const mac = process.platform === 'darwin';
  const window = new BrowserWindow({
    ...state.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: app.name,
    backgroundColor: background(),
    autoHideMenuBar: !mac,
    ...(mac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 12 },
        }
      : {}),
    ...(process.platform === 'linux'
      ? { icon: join(__dirname, '..', 'resources', 'icon.png') }
      : {}),
    webPreferences: {
      preload: join(__dirname, 'tabStripPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  mainWindow = window;
  if (state.maximized) window.maximize();
  trackWindowState(window);
  lockStrip(window.webContents);

  const manager = new TabManager({
    env,
    window,
    webPreferences: TAB_PREFERENCES,
    background,
    setup: setupTab,
    onContentsGone: (contentsId) => {
      if (badges.delete(contentsId)) applyBadge();
    },
  });
  tabs = manager;

  window.once('ready-to-show', () => window.show());
  window.on('focus', () => {
    const contents = manager.activeContents();
    if (contents !== null && !contents.isDestroyed()) contents.focus();
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
    if (tabs === manager) tabs = null;
  });

  void window.loadFile(join(__dirname, '..', 'resources', 'tabs.html'));
  const saved = loadSavedTabs(env);
  const start = pendingUrl;
  pendingUrl = null;
  manager.restore(saved, start ?? env.appOrigin);
  if (start !== null && saved !== null) manager.focusOrOpen(start);
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

/**
 * Reloads the tabs in the background when the refresh cookie arrives or is
 * removed, so a sign-in or sign-out in one tab applies to every tab. A cookie
 * replaced by a token refresh is neither.
 */
const watchSession = (): void => {
  const cookies = session.defaultSession.cookies;
  let signedIn = false;
  let timer: NodeJS.Timeout | undefined;
  const settle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => tabs?.reloadInactive(), SESSION_SETTLE_MS);
  };
  void cookies
    .get({ name: env.refreshCookie })
    .then((found) => {
      signedIn = found.length > 0;
    })
    .catch(() => undefined);
  cookies.on('changed', (_event, cookie, cause, removed) => {
    if (cookie.name !== env.refreshCookie) return;
    if (removed) {
      if (REPLACING_CAUSES.has(cause) || !signedIn) return;
      signedIn = false;
      settle();
    } else if (!signedIn) {
      signedIn = true;
      settle();
    }
  });
};

/**
 * Answers the bridge's badge, notification, theme, sign-in, open in browser
 * and open in new tab messages, and the tab strip's requests.
 */
const listen = (): void => {
  ipcMain.on(CHANNELS.badge, (event, raw: unknown) => {
    const badge = parseBadge(raw);
    if (badge === null || !fromApp(event)) return;
    badges.set(event.sender.id, badge);
    applyBadge();
  });

  ipcMain.on(CHANNELS.notify, (event, raw: unknown) => {
    const payload = parseNotify(raw);
    if (payload === null || !fromApp(event) || !Notification.isSupported()) {
      return;
    }
    if (recentNotifications.has(payload.path)) return;
    recentNotifications.add(payload.path);
    setTimeout(
      () => recentNotifications.delete(payload.path),
      NOTIFY_DEDUPE_MS
    );
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
    if (mainWindow !== null && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(background());
    }
    tabs?.setBackground(background());
  });

  ipcMain.on(CHANNELS.signInWithBrowser, (event) => {
    if (!fromApp(event)) return;
    void startBrowserSignIn(env).catch(() => undefined);
  });

  ipcMain.on(CHANNELS.openExternal, (event, raw: unknown) => {
    if (!fromApp(event) || typeof raw !== 'string') return;
    openExternal(raw);
  });

  ipcMain.on(CHANNELS.openInNewTab, (event, raw: unknown) => {
    if (!fromApp(event) || typeof raw !== 'string' || !isAppPath(raw)) return;
    const url = new URL(raw, env.appOrigin);
    if (url.origin !== env.appOrigin) return;
    tabs?.open(url.toString(), { background: true });
  });

  ipcMain.on(CHANNELS.tabCommand, (event, raw: unknown) => {
    if (!fromStrip(event)) return;
    const command = parseTabCommand(raw);
    if (command !== null) tabs?.command(command);
  });
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.defaultApp && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(env.scheme, process.execPath, [
      join(process.cwd(), process.argv[1]),
    ]);
  } else if (appImagePath() !== null) {
    void registerAppImageHandler(env, app.getName());
  } else {
    app.setAsDefaultProtocolClient(env.scheme);
  }

  app.on('second-instance', (_event, argv) => {
    const link =
      handoffCallbackFromArgv(argv, env) ?? deepLinkFromArgv(argv, env);
    if (link === null || !handleDeepLink(link)) {
      if (mainWindow === null && app.isReady()) createWindow();
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
    watchSession();
    const checkForUpdates = startUpdater(env);
    installMenu({
      env,
      mainWindow: () => mainWindow,
      tabs: () => tabs,
      checkForUpdates,
    });
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
