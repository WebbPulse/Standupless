/**
 * Deep links into the mobile app: which links route into the page, and that
 * the sign-in handoff's one-time code never does.
 */

import { describe, expect, it } from 'vitest';
import { isMobileShell, mobileLinkPath } from './mobile';

const ORIGIN = 'https://standupless.dev';

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

  it('rejects values that are not URLs', () => {
    expect(mobileLinkPath('not a url', ORIGIN)).toBeNull();
  });
});

describe('isMobileShell', () => {
  it('is false in a browser', () => {
    expect(isMobileShell()).toBe(false);
  });
});
