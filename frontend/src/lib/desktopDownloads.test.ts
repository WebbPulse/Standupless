/**
 * The download page's build list and platform detection: every link points at
 * a version free name on the `desktop-latest` release, and each desktop
 * browser is offered its own build while phones are offered none first.
 */

import { describe, expect, it } from 'vitest';
import { DESKTOP_BUILDS, detectDesktopPlatform } from './desktop';

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LINUX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('detectDesktopPlatform', () => {
  it('recognises each desktop browser', () => {
    expect(detectDesktopPlatform(MAC)).toBe('mac');
    expect(detectDesktopPlatform(WINDOWS)).toBe('windows');
    expect(detectDesktopPlatform(LINUX)).toBe('linux');
  });

  it('prefers the platform hint over the user agent', () => {
    expect(detectDesktopPlatform(LINUX, 'macOS')).toBe('mac');
    expect(detectDesktopPlatform(MAC, 'Windows')).toBe('windows');
  });

  it('offers a phone no desktop build first', () => {
    expect(detectDesktopPlatform(ANDROID, 'Linux armv8l')).toBeNull();
    expect(detectDesktopPlatform(IPHONE, 'iPhone')).toBeNull();
    expect(detectDesktopPlatform('')).toBeNull();
  });
});

describe('DESKTOP_BUILDS', () => {
  it('links every build to a version free name on desktop-latest', () => {
    for (const build of DESKTOP_BUILDS) {
      expect(build.href).toBe(
        `https://github.com/WebbPulse/Standupless/releases/download/desktop-latest/${build.fileName}`
      );
      expect(build.fileName).not.toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it('covers every desktop platform', () => {
    expect(new Set(DESKTOP_BUILDS.map((build) => build.platform))).toEqual(
      new Set(['mac', 'windows', 'linux'])
    );
  });
});
