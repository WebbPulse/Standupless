/**
 * The URL scheme handler for the Linux AppImage. The deb installs a desktop
 * entry that claims the scheme, but an AppImage installs nothing, so without
 * this the browser has nowhere to send `<scheme>://` links and a browser
 * sign-in can never hand its code back. On every launch the AppImage writes a
 * hidden desktop entry that runs its current path, and makes it the default
 * handler for the scheme, so moving or updating the file keeps links working.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Environment } from './environment';

/** How long a desktop database helper may run before it is abandoned. */
const HELPER_TIMEOUT_MS = 10_000;

/** The AppImage's own path, or null when this run is not an AppImage. */
export const appImagePath = (): string | null => {
  if (process.platform !== 'linux') return null;
  const path = process.env.APPIMAGE ?? '';
  return path.startsWith('/') ? path : null;
};

/** The desktop entry's file name for a scheme. */
export const handlerFileName = (env: Environment): string =>
  `${env.scheme}-url-handler.desktop`;

/**
 * Quotes a path as one `Exec` argument: the quoting rule escapes `"`, `` ` ``,
 * `$` and `\`, the string rule then doubles every backslash, and `%` is
 * doubled so it is not read as a field code. Null when the path has a line
 * break, which no desktop entry can carry.
 */
export const execArgument = (path: string): string | null => {
  if (/[\r\n]/.test(path)) return null;
  const quoted = path.replace(/[\\"`$]/g, (char) => `\\${char}`);
  return `"${quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')}"`;
};

/** The desktop entry that opens `<scheme>://` links with the AppImage. */
export const handlerEntry = (
  env: Environment,
  name: string,
  path: string
): string | null => {
  const exec = execArgument(path);
  if (exec === null) return null;
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Exec=${exec} %u`,
    'Terminal=false',
    'NoDisplay=true',
    `MimeType=x-scheme-handler/${env.scheme};`,
    '',
  ].join('\n');
};

/** Where per-user desktop entries live. */
const applicationsDir = (): string => {
  const dataHome = process.env.XDG_DATA_HOME ?? '';
  return join(
    dataHome.startsWith('/') ? dataHome : join(homedir(), '.local', 'share'),
    'applications'
  );
};

/** Runs a desktop database helper, ignoring a missing binary or a failure. */
const runHelper = (command: string, args: readonly string[]): Promise<void> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: HELPER_TIMEOUT_MS }, () => resolve());
  });

/** Reads a file, or null when it does not exist yet. */
const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Registers the running AppImage as the scheme's handler. Does nothing outside
 * an AppImage, and never throws: a desktop without the XDG tools still runs
 * the app, it just cannot receive links.
 */
export const registerAppImageHandler = async (
  env: Environment,
  name: string
): Promise<void> => {
  const path = appImagePath();
  if (path === null) return;
  const entry = handlerEntry(env, name, path);
  if (entry === null) return;
  const dir = applicationsDir();
  const file = handlerFileName(env);
  try {
    const target = join(dir, file);
    if ((await readIfPresent(target)) !== entry) {
      await mkdir(dir, { recursive: true });
      await writeFile(target, entry, { mode: 0o644 });
      await runHelper('update-desktop-database', [dir]);
    }
    await runHelper('xdg-mime', [
      'default',
      file,
      `x-scheme-handler/${env.scheme}`,
    ]);
  } catch {
    return;
  }
};
