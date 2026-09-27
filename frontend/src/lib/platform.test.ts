import { describe, expect, it } from 'vitest';
import {
  isApplePlatform,
  modKeyLabel,
  shiftKeyLabel,
  submitKeysLabel,
} from './platform';

describe('isApplePlatform', () => {
  it('reads the client hint platform first', () => {
    expect(
      isApplePlatform({ userAgentData: { platform: 'macOS' }, platform: '' })
    ).toBe(true);
  });

  it('falls back to the legacy platform and the user agent', () => {
    expect(isApplePlatform({ platform: 'MacIntel' })).toBe(true);
    expect(isApplePlatform({ userAgent: 'Mozilla/5.0 (iPhone)' })).toBe(true);
    expect(isApplePlatform({ platform: 'Linux x86_64' })).toBe(false);
    expect(isApplePlatform({ platform: 'Win32' })).toBe(false);
  });

  it('answers false without a navigator', () => {
    expect(isApplePlatform(undefined)).toBe(false);
  });
});

describe('key labels', () => {
  it('names Ctrl off Apple and the symbols on Apple', () => {
    expect(modKeyLabel(false)).toBe('Ctrl');
    expect(modKeyLabel(true)).toBe('⌘');
    expect(shiftKeyLabel(false)).toBe('Shift');
    expect(shiftKeyLabel(true)).toBe('⇧');
    expect(submitKeysLabel(false)).toBe('Ctrl ↵');
    expect(submitKeysLabel(true)).toBe('⌘↵');
  });
});
