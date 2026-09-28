/**
 * The addresses and commands the MCP and CLI settings page hands out, built
 * from the same API base the application's own client calls, so a staging
 * build shows staging addresses and a production build shows production ones.
 */

import { appConfig, PRODUCTION_API_URL, STAGING_API_URL } from '../config/app';

/** The name every client registers the MCP server under. */
export const MCP_SERVER_NAME = 'standupless';

/** The package the CLI is published as. */
export const CLI_PACKAGE = 'standupless-cli';

/** The command that installs the CLI with pip. */
export const CLI_INSTALL_PIP = `pip install ${CLI_PACKAGE}`;

/** The command that installs the CLI with pipx. */
export const CLI_INSTALL_PIPX = `pipx install ${CLI_PACKAGE}`;

/** Strips trailing slashes so joined paths never double one up. */
const trimSlashes = (value: string): string => value.replace(/\/+$/, '');

/**
 * The absolute API base, `https://api.example.com/api`, resolving a relative
 * base such as the development default of `/api` against the page's origin.
 */
export const absoluteApiBase = (
  apiBaseUrl: string = appConfig.apiBaseUrl,
  origin: string = globalThis.location.origin
): string => trimSlashes(new URL(trimSlashes(apiBaseUrl), origin).href);

/** The API origin with no path, which is what the CLI's `--base-url` takes. */
export const apiOrigin = (
  apiBaseUrl: string = appConfig.apiBaseUrl,
  origin: string = globalThis.location.origin
): string => new URL(absoluteApiBase(apiBaseUrl, origin)).origin;

/** The remote MCP server address, `<API base>/mcp`. */
export const mcpServerUrl = (
  apiBaseUrl: string = appConfig.apiBaseUrl,
  origin: string = globalThis.location.origin
): string => `${absoluteApiBase(apiBaseUrl, origin)}/mcp`;

/**
 * The CLI's global flags that point it at this environment: none for
 * production, which is its default, `--env staging` for staging, and
 * `--base-url` for anything else.
 */
export const cliTargetFlags = (
  apiBaseUrl: string = appConfig.apiBaseUrl,
  origin: string = globalThis.location.origin
): string => {
  const target = apiOrigin(apiBaseUrl, origin);
  if (target === PRODUCTION_API_URL) return '';
  if (target === STAGING_API_URL) return ' --env staging';
  return ` --base-url ${target}`;
};

/** The Claude Code command that adds the server. */
export const claudeCodeCommand = (url: string): string =>
  `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`;

/** The entry for Cursor's `~/.cursor/mcp.json`. */
export const cursorConfig = (url: string): string =>
  JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url } } }, null, 2);

/** The entry for VS Code's `.vscode/mcp.json`. */
export const vscodeConfig = (url: string): string =>
  JSON.stringify(
    { servers: { [MCP_SERVER_NAME]: { type: 'http', url } } },
    null,
    2
  );
