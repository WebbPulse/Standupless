/**
 * Auto-update through electron-updater against the fixed `desktop-latest`
 * release the desktop workflow keeps current, read through the generic
 * provider in app-update.yml. Only packaged production builds check; a
 * staging or development run never replaces itself.
 *
 * macOS refuses to install an update into an unsigned app, so while the builds
 * are unsigned a Mac only announces a new version and links to the download.
 * SIGNING.md says when to turn that off.
 */

import { app, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { DOWNLOADS_URL, type Environment } from './environment';

/** Whether this build only announces updates rather than installing them. */
const ANNOUNCE_ONLY = process.platform === 'darwin';

/** How often a running app checks again. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** Whether this run may update itself. */
const canUpdate = (env: Environment): boolean =>
  env.autoUpdate && app.isPackaged;

/** Starts the periodic background check and returns the manual check. */
export const startUpdater = (env: Environment): (() => void) => {
  if (!canUpdate(env)) {
    return () => {
      void dialog.showMessageBox({
        type: 'info',
        message: 'Updates are off in this build.',
        detail: 'Development and staging builds do not update themselves.',
      });
    };
  }

  autoUpdater.autoDownload = !ANNOUNCE_ONLY;
  autoUpdater.autoInstallOnAppQuit = !ANNOUNCE_ONLY;
  autoUpdater.allowPrerelease = false;

  let announced: string | null = null;
  const announce = (version: string): void => {
    if (announced === version) return;
    announced = version;
    void dialog
      .showMessageBox({
        type: 'info',
        message: `Standupless ${version} is available.`,
        detail: `You have version ${app.getVersion()}. Download the new version and replace the app in Applications.`,
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) void shell.openExternal(DOWNLOADS_URL);
      });
  };

  const background = (): void => {
    if (ANNOUNCE_ONLY) {
      autoUpdater
        .checkForUpdates()
        .then((result) => {
          if (result?.isUpdateAvailable === true) {
            announce(result.updateInfo.version);
          }
        })
        .catch(() => undefined);
      return;
    }
    autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
  };
  background();
  setInterval(background, CHECK_INTERVAL_MS).unref();

  return () => {
    autoUpdater
      .checkForUpdates()
      .then((result) => {
        const available = result !== null && result.isUpdateAvailable === true;
        void dialog.showMessageBox({
          type: 'info',
          message: available
            ? `Downloading Standupless ${result.updateInfo.version}.`
            : 'Standupless is up to date.',
          detail: available
            ? 'It installs the next time you quit the app.'
            : `You have version ${app.getVersion()}.`,
        });
      })
      .catch((error: unknown) => {
        void dialog.showMessageBox({
          type: 'warning',
          message: 'Could not check for updates.',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
  };
};
