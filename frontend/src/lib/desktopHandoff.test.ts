/**
 * The browser to desktop sign-in handoff helpers: the scheme list a build is
 * configured with, the bridge entry point, and the copy for a failed handoff.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { parseDesktopHandoffSchemes } from '../config/app';
import { describeDesktopHandoffFailure, desktopBrowserSignIn } from './desktop';

afterEach(() => {
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('parseDesktopHandoffSchemes', () => {
  it('treats unset and blank as no schemes', () => {
    expect(parseDesktopHandoffSchemes(undefined)).toEqual([]);
    expect(parseDesktopHandoffSchemes('  ')).toEqual([]);
  });

  it('reads a comma separated list', () => {
    expect(
      parseDesktopHandoffSchemes('standupless, Standupless-Staging')
    ).toEqual(['standupless', 'standupless-staging']);
  });

  it('reads a JSON array and ignores a malformed one', () => {
    expect(parseDesktopHandoffSchemes('["standupless"]')).toEqual([
      'standupless',
    ]);
    expect(parseDesktopHandoffSchemes('[standupless')).toEqual([]);
  });
});

describe('desktopBrowserSignIn', () => {
  it('is null in a browser', () => {
    expect(desktopBrowserSignIn()).toBeNull();
  });

  it('is null on a desktop build without the handoff', () => {
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      setBadgeCount: () => undefined,
    };
    expect(desktopBrowserSignIn()).toBeNull();
  });

  it('calls the bridge on a desktop build with the handoff', () => {
    let calls = 0;
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      setBadgeCount: () => undefined,
      signInWithBrowser: () => {
        calls += 1;
      },
    };
    desktopBrowserSignIn()?.();
    expect(calls).toBe(1);
  });
});

describe('describeDesktopHandoffFailure', () => {
  it('says nothing without a reason', () => {
    expect(describeDesktopHandoffFailure(null)).toBeNull();
    expect(describeDesktopHandoffFailure('')).toBeNull();
  });

  it('sends every failure back to the app', () => {
    for (const reason of ['invalid', 'expired', 'rate-limited', 'refused']) {
      expect(describeDesktopHandoffFailure(reason)).toMatch(
        /start again from the app/i
      );
    }
  });
});
