/**
 * The authorize return allowlist: only the API's own authorize endpoint passes.
 */

import { describe, expect, it } from 'vitest';
import {
  authorizeReturn,
  loginReturnFor,
  wantsFreshLogin,
} from './authorizeReturn';

const ORIGIN = 'https://api.standupless.dev';
const AUTHORIZE =
  'https://api.standupless.dev/api/auth/authorize?response_type=code&client_id=abc&state=s';

describe('authorizeReturn', () => {
  it('accepts the authorize endpoint on the identity origin', () => {
    expect(authorizeReturn(AUTHORIZE, ORIGIN)).toBe(AUTHORIZE);
  });

  it.each([
    ['empty', ''],
    ['a relative path', '/api/auth/authorize?x=1'],
    ['another host', 'https://evil.example.com/api/auth/authorize'],
    [
      'a look-alike host',
      'https://api.standupless.dev.evil.com/api/auth/authorize',
    ],
    [
      'credentials in the URL',
      'https://api.standupless.dev@evil.com/api/auth/authorize',
    ],
    [
      'user info on the right host',
      'https://u:p@api.standupless.dev/api/auth/authorize',
    ],
    [
      'plaintext on the https origin',
      'http://api.standupless.dev/api/auth/authorize',
    ],
    ['another port', 'https://api.standupless.dev:8443/api/auth/authorize'],
    ['another path', 'https://api.standupless.dev/api/auth/token'],
    ['a longer path', 'https://api.standupless.dev/api/auth/authorize/consent'],
    ['a fragment', 'https://api.standupless.dev/api/auth/authorize#x'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
  ])('refuses %s', (_label, value) => {
    expect(authorizeReturn(value, ORIGIN)).toBeNull();
  });

  it('refuses null', () => {
    expect(authorizeReturn(null, ORIGIN)).toBeNull();
  });
});

describe('wantsFreshLogin', () => {
  it('is true only for prompt=login', () => {
    expect(wantsFreshLogin(new URLSearchParams('prompt=login'))).toBe(true);
    expect(wantsFreshLogin(new URLSearchParams('prompt=none'))).toBe(false);
    expect(wantsFreshLogin(new URLSearchParams(''))).toBe(false);
  });
});

describe('loginReturnFor', () => {
  it('routes a provider sign in back through the login page', () => {
    expect(loginReturnFor(AUTHORIZE)).toBe(
      `/login?returnTo=${encodeURIComponent(AUTHORIZE)}`
    );
  });
});
