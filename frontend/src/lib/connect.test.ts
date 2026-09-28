/**
 * The MCP and CLI addresses: built from the API base the client calls,
 * resolved against the page for a relative base, and the CLI pointed at the
 * environment that base belongs to.
 */

import { describe, expect, it } from 'vitest';
import {
  absoluteApiBase,
  claudeCodeCommand,
  cliTargetFlags,
  cursorConfig,
  mcpServerUrl,
  vscodeConfig,
} from './connect';

const ORIGIN = 'https://standupless.dev';

describe('mcpServerUrl', () => {
  it('appends mcp to an absolute API base', () => {
    expect(mcpServerUrl('https://api.standupless.dev/api', ORIGIN)).toBe(
      'https://api.standupless.dev/api/mcp'
    );
  });

  it('ignores a trailing slash on the base', () => {
    expect(mcpServerUrl('https://api.standupless.dev/api/', ORIGIN)).toBe(
      'https://api.standupless.dev/api/mcp'
    );
  });

  it('resolves a relative base against the page origin', () => {
    expect(mcpServerUrl('/api', 'http://localhost:5173')).toBe(
      'http://localhost:5173/api/mcp'
    );
    expect(absoluteApiBase('/api', 'http://localhost:5173')).toBe(
      'http://localhost:5173/api'
    );
  });
});

describe('cliTargetFlags', () => {
  it('adds nothing for production, the CLI default', () => {
    expect(cliTargetFlags('https://api.standupless.dev/api', ORIGIN)).toBe('');
  });

  it('names the staging environment for the staging API', () => {
    expect(
      cliTargetFlags('https://api.staging.standupless.dev/api', ORIGIN)
    ).toBe(' --env staging');
  });

  it('passes any other API origin as a base URL', () => {
    expect(cliTargetFlags('/api', 'http://localhost:5173')).toBe(
      ' --base-url http://localhost:5173'
    );
  });
});

describe('the client snippets', () => {
  const url = 'https://api.standupless.dev/api/mcp';

  it('adds the server to Claude Code over HTTP', () => {
    expect(claudeCodeCommand(url)).toBe(
      'claude mcp add --transport http standupless https://api.standupless.dev/api/mcp'
    );
  });

  it('writes a Cursor mcpServers entry with a url', () => {
    expect(JSON.parse(cursorConfig(url))).toEqual({
      mcpServers: { standupless: { url } },
    });
  });

  it('writes a VS Code servers entry of type http', () => {
    expect(JSON.parse(vscodeConfig(url))).toEqual({
      servers: { standupless: { type: 'http', url } },
    });
  });
});
