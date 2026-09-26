/**
 * The theme default: a fresh browser gets dark, both from the setting the app
 * reads and from the pre-paint script in index.html, which runs before any
 * bundle loads and must agree with it or the first frame flashes. Light and
 * system stay selectable and are remembered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  DEFAULT_THEME,
  nextTheme,
  parseTheme,
  readTheme,
  THEME_STORAGE_KEY,
} from './theme';

const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');

/** The inline pre-paint script, the only non-module script in the page head. */
const prePaint = (): string => {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (match?.[1] === undefined) throw new Error('no pre-paint script');
  return match[1];
};

/** Resets the document to what index.html ships, then runs the script. */
const runPrePaint = (stored: string | null): void => {
  const root = document.documentElement;
  root.setAttribute('data-theme', 'dark');
  document.head.innerHTML = '<meta name="theme-color" content="#141518" />';
  if (stored === null) {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    localStorage.setItem(THEME_STORAGE_KEY, stored);
  }
  runInNewContext(prePaint(), {
    localStorage: globalThis.localStorage,
    document: globalThis.document,
    window: globalThis,
  });
};

afterEach(() => {
  localStorage.clear();
  document.head.innerHTML = '';
  document.documentElement.removeAttribute('data-theme');
});

describe('the default', () => {
  it('is dark', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readTheme()).toBe('dark');
  });

  it('treats a stored value it does not know as the default', () => {
    expect(parseTheme('sepia')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
  });

  it('ships the page painted dark before any script runs', () => {
    expect(html).toMatch(/<html lang="en" data-theme="dark">/);
    expect(html).toContain('<meta name="theme-color" content="#141518" />');
  });

  it('reads the same storage key in the pre-paint script as the app', () => {
    expect(prePaint()).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('leaves a fresh browser dark in the pre-paint script', () => {
    runPrePaint(null);

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('choosing another theme', () => {
  it('paints light in the pre-paint script when light is stored', () => {
    runPrePaint('light');

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(
      document
        .querySelector('meta[name="theme-color"]')
        ?.getAttribute('content')
    ).toBe('#ffffff');
  });

  it('hands system to the media query in the pre-paint script', () => {
    runPrePaint('system');

    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers and paints the choice', () => {
    applyTheme('light');

    expect(readTheme()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    applyTheme('system');
    expect(readTheme()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('cycles dark, light, system', () => {
    expect(nextTheme('dark')).toBe('light');
    expect(nextTheme('light')).toBe('system');
    expect(nextTheme('system')).toBe('dark');
  });
});
