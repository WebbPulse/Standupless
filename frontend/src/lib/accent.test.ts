/**
 * The workspace accent: hex validation, the default fallback, the token scale
 * for both themes with its contrast clamping, and the cache the pre-paint
 * script reads.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_ATTRIBUTE,
  ACCENT_PRESETS,
  ACCENT_STORAGE_KEY,
  ACCENT_SURFACES,
  DEFAULT_ACCENT,
  TEXT_CONTRAST,
  clampForContrast,
  contrast,
  deriveAccentScale,
  normalizeAccent,
  paintAccent,
  rememberAccent,
  worstContrast,
} from './accent';

/** The pre-paint cache as the script in index.html reads it. */
const readCache = (): Record<string, Record<string, string> | undefined> =>
  JSON.parse(localStorage.getItem(ACCENT_STORAGE_KEY) ?? '{}') as Record<
    string,
    Record<string, string> | undefined
  >;

afterEach(() => {
  paintAccent(null);
  localStorage.clear();
});

describe('normalizeAccent', () => {
  it('accepts six hex digits in any case, with or without the hash', () => {
    expect(normalizeAccent('#B8451A')).toBe('#b8451a');
    expect(normalizeAccent(' 1f7ae0 ')).toBe('#1f7ae0');
  });

  it('refuses shorthand, alpha and anything else', () => {
    for (const value of ['#fff', '#b8451a80', 'orange', '', '#gggggg']) {
      expect(normalizeAccent(value)).toBeNull();
    }
  });
});

describe('deriveAccentScale', () => {
  it('keeps the Standupless orange unchanged in light mode', () => {
    expect(deriveAccentScale(DEFAULT_ACCENT).light.accent).toBe(DEFAULT_ACCENT);
  });

  it('holds every preset and an awkward range of picks to AA in both themes', () => {
    const picks = [
      ...ACCENT_PRESETS.map((preset) => preset.swatch),
      '#ffff00',
      '#ffffff',
      '#000000',
      '#0a0a40',
      '#7fffd4',
      '#808080',
    ];
    for (const pick of picks) {
      const scale = deriveAccentScale(pick);
      for (const theme of ['light', 'dark'] as const) {
        const tokens = scale[theme];
        expect(
          worstContrast(tokens.accent, ACCENT_SURFACES[theme])
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        expect(contrast(tokens.onAccent, tokens.accent)).toBeGreaterThanOrEqual(
          TEXT_CONTRAST
        );
        expect(
          contrast(tokens.onAccent, tokens.accentStrong)
        ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        expect(
          worstContrast(tokens.focus, ACCENT_SURFACES[theme])
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('darkens a pale pick on light and lightens a deep one on dark, keeping the hue', () => {
    const yellow = clampForContrast('#ffd400', 'light');
    expect(yellow).not.toBe('#ffd400');
    expect(worstContrast(yellow, ACCENT_SURFACES.light)).toBeLessThan(
      TEXT_CONTRAST + 0.2
    );
    const navy = clampForContrast('#0a0a40', 'dark');
    expect(navy).not.toBe('#0a0a40');
    const red = parseInt(navy.slice(1, 3), 16);
    const green = parseInt(navy.slice(3, 5), 16);
    const blue = parseInt(navy.slice(5, 7), 16);
    expect(blue).toBeGreaterThan(red);
    expect(blue).toBeGreaterThan(green);
  });

  it('leaves a pick that already passes alone', () => {
    expect(clampForContrast('#b8451a', 'light')).toBe('#b8451a');
  });
});

describe('paintAccent', () => {
  it('writes the scale beside the attribute, and null returns to the default', () => {
    const root = document.documentElement;
    paintAccent('#1F7AE0');
    expect(root.getAttribute(ACCENT_ATTRIBUTE)).toBe('#1f7ae0');
    expect(root.style.getPropertyValue('--ws-light-accent')).toBe(
      deriveAccentScale('#1f7ae0').light.accent
    );
    expect(root.style.getPropertyValue('--ws-dark-on-accent')).toBe('#141518');
    paintAccent(null);
    expect(root.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
    expect(root.style.getPropertyValue('--ws-light-accent')).toBe('');
  });

  it('treats an invalid stored value as the default', () => {
    paintAccent('not a color');
    expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
  });
});

describe('rememberAccent', () => {
  it('caches the derived properties per slug and forgets a reset', () => {
    rememberAccent('acme', '#1f7ae0');
    rememberAccent('other', '#2f9e44');
    const held = readCache();
    expect(held['acme']?.['--ws-light-accent']).toBe(
      deriveAccentScale('#1f7ae0').light.accent
    );
    rememberAccent('acme', null);
    const after = readCache();
    expect(after['acme']).toBeUndefined();
    expect(after['other']).toBeDefined();
  });

  it('survives a corrupt cache', () => {
    localStorage.setItem(ACCENT_STORAGE_KEY, '[not json');
    rememberAccent('acme', '#1f7ae0');
    expect(readCache()['acme']).toBeDefined();
  });
});
