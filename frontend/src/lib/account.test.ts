/**
 * The account settings wording: usernames the mention parser can read, and
 * how a session's device and client read.
 */

import { describe, expect, it } from 'vitest';
import { USERNAME_PATTERN, deviceLabel, sessionLabel } from './account';

describe('USERNAME_PATTERN', () => {
  it('accepts a handle the mention parser reads', () => {
    expect(USERNAME_PATTERN.test('ada')).toBe(true);
    expect(USERNAME_PATTERN.test('ada_lovelace-1')).toBe(true);
  });

  it('refuses spaces, a leading symbol and anything over 39 characters', () => {
    expect(USERNAME_PATTERN.test('Ada Lovelace')).toBe(false);
    expect(USERNAME_PATTERN.test('-ada')).toBe(false);
    expect(USERNAME_PATTERN.test('a'.repeat(40))).toBe(false);
  });
});

describe('session labels', () => {
  it('names known devices and falls back for the rest', () => {
    expect(deviceLabel('mobile')).toBe('Mobile');
    expect(deviceLabel('toaster')).toBe('Unknown device');
  });

  const blank = { device: 'desktop', client: '', platform: '', clientId: '' };

  it('names a browser by its platform', () => {
    expect(sessionLabel({ ...blank, platform: 'macOS' })).toBe(
      'Browser on macOS'
    );
    expect(sessionLabel(blank)).toBe('Desktop');
  });

  it('names the desktop app, the mobile app and the CLI', () => {
    expect(
      sessionLabel({ ...blank, client: 'Standupless', platform: 'Windows' })
    ).toBe('Standupless desktop on Windows');
    expect(
      sessionLabel({ ...blank, client: 'Standupless', platform: 'iOS' })
    ).toBe('Standupless mobile on iOS');
    expect(sessionLabel({ ...blank, client: 'standupless-cli' })).toBe(
      'Standupless CLI'
    );
  });

  it('names an MCP session by its connected app, then its client', () => {
    const mcp = {
      device: 'mcp:client-1:tenant-1',
      client: 'claude-code',
      platform: '',
      clientId: 'client-1',
    };
    expect(sessionLabel(mcp, 'Claude')).toBe('Claude');
    expect(sessionLabel(mcp)).toBe('Claude Code');
    expect(sessionLabel({ ...mcp, client: '' })).toBe('Connected app');
  });

  it('shows an unknown client by its own name', () => {
    expect(sessionLabel({ ...blank, client: 'python-httpx' })).toBe(
      'python-httpx'
    );
  });
});
