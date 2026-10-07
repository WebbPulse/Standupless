import { describe, expect, it } from 'vitest';
import { viaLabel } from './changeSource';

describe('viaLabel', () => {
  it('labels changes made through a client', () => {
    expect(viaLabel('mcp')).toBe('via MCP');
    expect(viaLabel('cli')).toBe('via CLI');
    expect(viaLabel('api')).toBe('via API');
  });

  it('leaves the web, automations and old rows unlabelled', () => {
    expect(viaLabel('web')).toBeNull();
    expect(viaLabel('github')).toBeNull();
    expect(viaLabel('system')).toBeNull();
    expect(viaLabel(null)).toBeNull();
    expect(viaLabel(undefined)).toBeNull();
  });
});
