/**
 * The tabs of the one window. Each tab is its own WebContentsView on the
 * hosted app, all in the default session, so a sign-in, a sign-out or a
 * badge applies to every tab at once. The window's own contents is the tab
 * strip, drawn from a local page, and the active tab's view fills the window
 * below it. A restored tab only loads when it is first shown, so a relaunch
 * with many tabs open starts as fast as one with a single tab.
 *
 * The list is saved to a small JSON file in the user data directory whenever
 * it changes, and restored on the next launch.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  WebContentsView,
  type BrowserWindow,
  type WebContents,
  type WebPreferences,
} from 'electron';
import type { Environment } from './environment';
import { CHANNELS, type StripState, type TabCommand } from './ipc';
import { isAppUrl } from './navigation';
import {
  matchTabShortcut,
  newTabUrl,
  parseSavedTabs,
  sameTabUrl,
  selectIndex,
  tabLabel,
  type SavedTabs,
  type TabShortcut,
} from './tabsModel';

/** The height of the tab strip, in CSS pixels. */
export const STRIP_HEIGHT = 38;

/** How many closed tabs Cmd/Ctrl+Shift+T can bring back. */
const MAX_CLOSED = 25;

/** How long the list settles before it is written. */
const SAVE_DELAY_MS = 400;

/** One open tab. */
interface Tab {
  id: number;
  url: string;
  title: string;
  loading: boolean;
  view: WebContentsView | null;
  contents: WebContents | null;
}

/** A closed tab, kept so it can be reopened where it was. */
interface ClosedTab {
  url: string;
  title: string;
  index: number;
}

/** What the tabs need from the rest of the shell. */
export interface TabHost {
  env: Environment;
  window: BrowserWindow;
  webPreferences: WebPreferences;
  background: () => string;
  /** Applies the navigation allowlist and window handlers to a tab's contents. */
  setup: (contents: WebContents) => void;
  /** Called once a tab's contents is gone, with the id it had. */
  onContentsGone: (contentsId: number) => void;
}

/** The file the tab list lives in. */
const statePath = (): string => join(app.getPath('userData'), 'tabs.json');

/** Reads the saved tab list, or null when there is none to trust. */
export const loadSavedTabs = (env: Environment): SavedTabs | null => {
  try {
    return parseSavedTabs(JSON.parse(readFileSync(statePath(), 'utf8')), env);
  } catch {
    return null;
  }
};

/** The tabs of one window and the strip that draws them. */
export class TabManager {
  private readonly host: TabHost;
  private tabs: Tab[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private closed: ClosedTab[] = [];
  private backgroundInsert = 0;
  private saveTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  /** Wires the window's resize, full screen and close to the tabs. */
  constructor(host: TabHost) {
    this.host = host;
    const { window } = host;
    window.on('resize', () => this.layout());
    window.on('enter-full-screen', () => this.emit());
    window.on('leave-full-screen', () => this.emit());
    window.on('close', () => this.flush());
    window.on('closed', () => this.dispose());
    window.webContents.on('did-finish-load', () => this.emit());
    window.webContents.on('before-input-event', (event, input) => {
      if (this.handleShortcut(input)) event.preventDefault();
    });
  }

  /**
   * Opens the saved tabs, or one tab on `fallback` when none were saved. Only
   * the active one loads now.
   */
  restore(saved: SavedTabs | null, fallback: string): void {
    const list = saved?.tabs ?? [{ url: fallback, title: '' }];
    for (const item of list) {
      this.tabs.push(this.record(item.url, item.title));
    }
    const active = this.tabs[saved?.active ?? 0] ?? this.tabs[0];
    if (active !== undefined) this.activate(active.id);
  }

  /** The active tab's contents, or null while it has none. */
  activeContents(): WebContents | null {
    const tab = this.active();
    return tab?.contents ?? null;
  }

  /** Whether a contents is one of the tabs. */
  owns(contents: WebContents): boolean {
    return this.tabs.some((tab) => tab.contents === contents);
  }

  /**
   * Shows an app URL: focuses a tab already on that page, or opens a new
   * foreground tab on it.
   */
  focusOrOpen(url: string): void {
    const existing = this.tabs.find((tab) => sameTabUrl(tab.url, url));
    if (existing !== undefined) {
      this.activate(existing.id);
      return;
    }
    this.open(url, { background: false });
  }

  /**
   * Opens an app URL in a new tab. A background tab goes to the right of the
   * active one, after any others opened from it, and leaves focus where it is.
   */
  open(url: string, options: { background: boolean; index?: number }): void {
    if (this.disposed || !isAppUrl(url, this.host.env)) return;
    const activeIndex = this.indexOf(this.activeId);
    const tab = this.record(url, '');
    const index =
      options.index ??
      (options.background
        ? activeIndex + 1 + this.backgroundInsert
        : activeIndex + 1);
    this.tabs.splice(Math.min(Math.max(index, 0), this.tabs.length), 0, tab);
    if (options.background) {
      this.backgroundInsert += 1;
      this.ensureView(tab);
      this.emit();
    } else {
      this.activate(tab.id);
    }
  }

  /** Opens a new tab on the workspace home, at the end of the strip. */
  openNew(): void {
    const current = this.active()?.url ?? null;
    this.open(newTabUrl(current, this.host.env), {
      background: false,
      index: this.tabs.length,
    });
  }

  /** Loads a URL in the active tab, opening a tab when there is none. */
  loadInActive(url: string): void {
    const tab = this.active();
    if (tab === undefined) {
      this.open(url, { background: false });
      return;
    }
    tab.url = url;
    const contents = this.ensureView(tab);
    void contents.loadURL(url);
  }

  /** Reloads every loaded tab but the active one, after a sign-in or sign-out. */
  reloadInactive(): void {
    for (const tab of this.tabs) {
      if (tab.id === this.activeId) continue;
      if (tab.contents !== null && !tab.contents.isDestroyed()) {
        tab.contents.reload();
      }
    }
  }

  /** Paints every tab's background, for a theme change. */
  setBackground(color: string): void {
    for (const tab of this.tabs) tab.view?.setBackgroundColor(color);
  }

  /** Runs a request from the tab strip. */
  command(command: TabCommand): void {
    if (command.type === 'new') this.openNew();
    if (command.type === 'activate') this.activate(command.id);
    if (command.type === 'close') this.close(command.id);
    if (command.type === 'move') this.move(command.id, command.index);
  }

  /** Runs a tab shortcut, returning whether the key press was one. */
  handleShortcut(input: Electron.Input): boolean {
    const shortcut = matchTabShortcut(input, process.platform);
    if (shortcut === null) return false;
    this.run(shortcut);
    return true;
  }

  /** Runs a tab shortcut or the menu item that mirrors it. */
  run(shortcut: TabShortcut): void {
    if (shortcut.type === 'new') this.openNew();
    if (shortcut.type === 'close' && this.activeId !== null) {
      this.close(this.activeId);
    }
    if (shortcut.type === 'reopen') this.reopenClosed();
    if (shortcut.type === 'cycle') this.cycle(shortcut.delta);
    if (shortcut.type === 'select') {
      const index = selectIndex(shortcut.position, this.tabs.length);
      const tab = index === null ? undefined : this.tabs[index];
      if (tab !== undefined) this.activate(tab.id);
    }
  }

  /** Shows a tab, loading it first when it has never been shown. */
  activate(id: number): void {
    const tab = this.tabs.find((item) => item.id === id);
    if (tab === undefined || this.disposed) return;
    this.backgroundInsert = 0;
    const contents = this.ensureView(tab);
    this.activeId = id;
    for (const other of this.tabs) other.view?.setVisible(other.id === id);
    this.layout();
    contents.focus();
    this.emit();
  }

  /**
   * Closes a tab. Closing the last one closes the window instead, and the
   * list is kept, so the next launch opens on that tab again.
   */
  close(id: number): void {
    const index = this.indexOf(id);
    const tab = this.tabs[index];
    if (tab === undefined) return;
    if (this.tabs.length === 1) {
      this.host.window.close();
      return;
    }
    this.closed.push({ url: tab.url, title: tab.title, index });
    if (this.closed.length > MAX_CLOSED) this.closed.shift();
    this.tabs.splice(index, 1);
    if (id === this.activeId) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)];
      if (next !== undefined) this.activate(next.id);
    } else {
      this.emit();
    }
    this.destroy(tab);
  }

  /** Reopens the last closed tab where it was. */
  reopenClosed(): void {
    const last = this.closed.pop();
    if (last === undefined) return;
    this.open(last.url, { background: false, index: last.index });
  }

  /** Moves a tab to a new place in the strip. */
  move(id: number, index: number): void {
    const from = this.indexOf(id);
    const tab = this.tabs[from];
    if (tab === undefined) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
    this.emit();
  }

  /** Writes the list now, for the window closing. */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.save();
  }

  /** The active tab. */
  private active(): Tab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeId);
  }

  /** A tab's place in the strip, or -1. */
  private indexOf(id: number | null): number {
    return this.tabs.findIndex((tab) => tab.id === id);
  }

  /** Steps to the next or previous tab, wrapping round. */
  private cycle(delta: 1 | -1): void {
    if (this.tabs.length < 2) return;
    const index = this.indexOf(this.activeId);
    const next =
      this.tabs[(index + delta + this.tabs.length) % this.tabs.length];
    if (next !== undefined) this.activate(next.id);
  }

  /** A new tab record, not yet loaded. */
  private record(url: string, title: string): Tab {
    const id = this.nextId;
    this.nextId += 1;
    return {
      id,
      url,
      title: tabLabel(title, url),
      loading: false,
      view: null,
      contents: null,
    };
  }

  /** The tab's contents, creating its view and loading its URL the first time. */
  private ensureView(tab: Tab): WebContents {
    if (tab.contents !== null) return tab.contents;
    const view = new WebContentsView({
      webPreferences: this.host.webPreferences,
    });
    view.setBackgroundColor(this.host.background());
    view.setVisible(false);
    this.host.window.contentView.addChildView(view);
    const contents = view.webContents;
    const contentsId = contents.id;
    tab.view = view;
    tab.contents = contents;
    this.host.setup(contents);

    const relabel = (): void => {
      if (contents.isDestroyed()) return;
      const url = contents.getURL();
      if (isAppUrl(url, this.host.env)) tab.url = url;
      tab.title = tabLabel(contents.getTitle(), tab.url);
      this.emit();
    };
    contents.on('page-title-updated', relabel);
    contents.on('did-navigate', relabel);
    contents.on('did-navigate-in-page', relabel);
    contents.on('did-start-loading', () => {
      tab.loading = true;
      this.emit();
    });
    contents.on('did-stop-loading', () => {
      tab.loading = false;
      relabel();
    });
    contents.on('before-input-event', (event, input) => {
      if (this.handleShortcut(input)) event.preventDefault();
    });
    contents.once('destroyed', () => {
      this.host.onContentsGone(contentsId);
    });

    this.layoutView(view);
    void contents.loadURL(tab.url);
    return contents;
  }

  /** Closes a tab's contents and takes its view off the window. */
  private destroy(tab: Tab): void {
    const { view, contents } = tab;
    tab.view = null;
    tab.contents = null;
    if (view !== null && !this.disposed) {
      this.host.window.contentView.removeChildView(view);
    }
    if (contents !== null && !contents.isDestroyed()) contents.close();
  }

  /** Sizes one tab view to the area below the strip. */
  private layoutView(view: WebContentsView): void {
    if (this.disposed || this.host.window.isDestroyed()) return;
    const [width = 0, height = 0] = this.host.window.getContentSize();
    view.setBounds({
      x: 0,
      y: STRIP_HEIGHT,
      width,
      height: Math.max(0, height - STRIP_HEIGHT),
    });
  }

  /** Sizes every tab view, so a background tab lays out at the right size. */
  private layout(): void {
    for (const tab of this.tabs) {
      if (tab.view !== null) this.layoutView(tab.view);
    }
  }

  /** Sends the strip its state and schedules a save. */
  private emit(): void {
    if (this.disposed || this.host.window.isDestroyed()) return;
    const strip = this.host.window.webContents;
    const state: StripState = {
      tabs: this.tabs.map(({ id, title, loading }) => ({ id, title, loading })),
      activeId: this.activeId,
      inset: process.platform === 'darwin' && !this.host.window.isFullScreen(),
    };
    if (!strip.isDestroyed()) strip.send(CHANNELS.tabsState, state);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  /** Writes the list, ignoring a failed write. */
  private save(): void {
    if (this.tabs.length === 0) return;
    const saved: SavedTabs = {
      tabs: this.tabs.map(({ url, title }) => ({ url, title })),
      active: Math.max(0, this.indexOf(this.activeId)),
    };
    try {
      writeFileSync(statePath(), JSON.stringify(saved));
    } catch {
      return;
    }
  }

  /**
   * Lets go of every tab once the window is gone. Only the contents objects
   * kept at creation are touched, never the destroyed window's.
   */
  private dispose(): void {
    clearTimeout(this.saveTimer);
    this.disposed = true;
    for (const tab of this.tabs) this.destroy(tab);
    this.tabs = [];
    this.activeId = null;
  }
}
