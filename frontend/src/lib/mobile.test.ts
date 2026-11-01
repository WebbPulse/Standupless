/**
 * Deep links into the mobile app: which links route into the page, and that
 * the sign-in handoff's one-time code never does.
 */

import { isDesktopHandoffCallback } from '@webbpulse/auth';
import { describe, expect, it } from 'vitest';
import { isMobileShell, mobileLinkPath, pushTapPath } from './mobile';

const ORIGIN = 'https://standupless.dev';

describe('pushTapPath', () => {
  it('opens a workspace page the payload names', () => {
    expect(pushTapPath({ path: '/w/acme/issues/STUP-1', aps: {} })).toBe(
      '/w/acme/issues/STUP-1'
    );
  });

  it('ignores a payload with no workspace page', () => {
    expect(pushTapPath({ path: 'https://example.com/w/acme' })).toBeNull();
    expect(pushTapPath({ path: '//example.com' })).toBeNull();
    expect(pushTapPath({ path: 7 })).toBeNull();
    expect(pushTapPath({})).toBeNull();
    expect(pushTapPath(null)).toBeNull();
  });
});

describe('mobileLinkPath', () => {
  it('routes a universal link on the app origin', () => {
    expect(
      mobileLinkPath(
        'https://standupless.dev/w/acme/issues/STUP-1?x=1#c',
        ORIGIN
      )
    ).toBe('/w/acme/issues/STUP-1?x=1#c');
  });

  it('ignores https links on another origin', () => {
    expect(
      mobileLinkPath('https://staging.standupless.dev/w/acme', ORIGIN)
    ).toBeNull();
    expect(mobileLinkPath('https://example.com/w/acme', ORIGIN)).toBeNull();
  });

  it('ignores plain http links', () => {
    expect(mobileLinkPath('http://standupless.dev/w/acme', ORIGIN)).toBeNull();
  });

  it('routes a custom scheme link to the matching path', () => {
    expect(mobileLinkPath('standupless://w/acme/issues/STUP-2', ORIGIN)).toBe(
      '/w/acme/issues/STUP-2'
    );
    expect(
      mobileLinkPath('standupless-staging:///w/acme/inbox?tab=all', ORIGIN)
    ).toBe('/w/acme/inbox?tab=all');
  });

  it('never routes the sign-in handoff link', () => {
    expect(
      mobileLinkPath('standupless://auth/handoff?code=secret', ORIGIN)
    ).toBeNull();
  });

  it('never routes another path on the handoff host', () => {
    const link = 'standupless://auth/other?code=secret';
    expect(isDesktopHandoffCallback(link, ['standupless'])).toBe(false);
    expect(mobileLinkPath(link, ORIGIN)).toBeNull();
  });

  it('rejects values that are not URLs', () => {
    expect(mobileLinkPath('not a url', ORIGIN)).toBeNull();
  });
});

describe('isMobileShell', () => {
  it('is false in a browser', () => {
    expect(isMobileShell()).toBe(false);
  });
});
