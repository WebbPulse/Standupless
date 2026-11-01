/**
 * The mobile browser sign-in: the verifier kept on the device, which app links
 * count as a handoff, and the path the page goes to once a handoff settles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeMobileAuthSession,
  completeMobileBrowserSignIn,
  hasPendingMobileHandoff,
  isMobileHandoffLink,
  isMobileSignInCancelled,
  MOBILE_HANDOFF_STORAGE_KEY,
  MOBILE_HANDOFF_TTL_MS,
  mobileBrowserSignIn,
  mobileHandoffFailedPath,
  mobileHandoffScheme,
  startMobileBrowserSignIn,
  storeMobileHandoffVerifier,
  takeMobileHandoffVerifier,
} from './mobileHandoff';

const native = vi.hoisted(() => ({
  platform: 'android',
  start: vi.fn(),
  close: vi.fn(),
  browserOpen: vi.fn(),
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => native.platform,
      isNativePlatform: () => false,
    },
    registerPlugin: () => ({ start: native.start, close: native.close }),
  };
});

vi.mock('@capacitor/browser', () => ({
  Browser: { open: native.browserOpen },
}));

vi.mock('@webbpulse/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@webbpulse/auth')>();
  return {
    ...actual,
    createDesktopHandoffPkce: () =>
      Promise.resolve({ verifier: 'v'.repeat(43), challenge: 'challenge' }),
    desktopHandoffLaunchUrl: () => LAUNCH_URL,
  };
});

const LAUNCH_URL = 'https://app.example/desktop/handoff?challenge=challenge';
const CALLBACK = 'standupless://auth/handoff?code=abc';
const SCHEMES = ['standupless', 'standupless-staging'];

/** What the page passes the client to redeem a code. */
interface HandoffInput {
  url: string;
  codeVerifier: string;
}
const VERIFIER = 'v'.repeat(43);

afterEach(() => {
  localStorage.removeItem(MOBILE_HANDOFF_STORAGE_KEY);
});

describe('the pending verifier', () => {
  it('is taken once', () => {
    storeMobileHandoffVerifier(VERIFIER, 1000);
    expect(hasPendingMobileHandoff()).toBe(true);
    expect(takeMobileHandoffVerifier(2000)).toBe(VERIFIER);
    expect(hasPendingMobileHandoff()).toBe(false);
    expect(takeMobileHandoffVerifier(2000)).toBeNull();
  });

  it('expires after the time limit', () => {
    storeMobileHandoffVerifier(VERIFIER, 0);
    expect(takeMobileHandoffVerifier(MOBILE_HANDOFF_TTL_MS + 1)).toBeNull();
    expect(hasPendingMobileHandoff()).toBe(false);
  });

  it('is replaced by a newer sign-in', () => {
    storeMobileHandoffVerifier(VERIFIER, 0);
    storeMobileHandoffVerifier('w'.repeat(43), 0);
    expect(takeMobileHandoffVerifier(1)).toBe('w'.repeat(43));
  });

  it('ignores an unreadable stored value', () => {
    localStorage.setItem(MOBILE_HANDOFF_STORAGE_KEY, '{not json');
    expect(takeMobileHandoffVerifier()).toBeNull();
    localStorage.setItem(MOBILE_HANDOFF_STORAGE_KEY, '{"verifier":1}');
    expect(takeMobileHandoffVerifier()).toBeNull();
  });

  it('answers nothing without storage', () => {
    storeMobileHandoffVerifier(VERIFIER, 0, null);
    expect(takeMobileHandoffVerifier(0, null)).toBeNull();
    expect(hasPendingMobileHandoff(null)).toBe(false);
  });
});

describe('isMobileHandoffLink', () => {
  it('matches the handoff callback on an allowed scheme', () => {
    expect(
      isMobileHandoffLink('standupless://auth/handoff?code=abc', SCHEMES)
    ).toBe(true);
    expect(
      isMobileHandoffLink('standupless-staging://auth/handoff', SCHEMES)
    ).toBe(true);
  });

  it('ignores other links and schemes', () => {
    expect(isMobileHandoffLink('standupless://w/acme', SCHEMES)).toBe(false);
    expect(isMobileHandoffLink('other://auth/handoff?code=abc', SCHEMES)).toBe(
      false
    );
    expect(
      isMobileHandoffLink('https://standupless.dev/auth/handoff', SCHEMES)
    ).toBe(false);
    expect(isMobileHandoffLink('not a url', SCHEMES)).toBe(false);
  });
});

describe('mobileHandoffScheme', () => {
  it('is the first configured scheme, or null without one', () => {
    expect(mobileHandoffScheme(['standupless-staging'])).toBe(
      'standupless-staging'
    );
    expect(mobileHandoffScheme([])).toBeNull();
  });
});

describe('mobileBrowserSignIn', () => {
  it('is null in a browser', () => {
    expect(mobileBrowserSignIn()).toBeNull();
  });
});

describe('completeMobileBrowserSignIn', () => {
  const link = 'standupless://auth/handoff?code=abc';

  it('goes to the workspaces once the code is redeemed', async () => {
    const calls: HandoffInput[] = [];
    const client = {
      completeDesktopHandoff: (input: HandoffInput) => {
        calls.push(input);
        return Promise.resolve({
          ok: true as const,
          user: null,
          expiresIn: undefined,
        });
      },
    };
    const path = await completeMobileBrowserSignIn(link, client, VERIFIER);
    expect(path).toBe('/workspaces');
    expect(calls).toEqual([{ url: link, codeVerifier: VERIFIER }]);
  });

  it('returns to sign in with the refusal reason', async () => {
    const client = {
      completeDesktopHandoff: () =>
        Promise.resolve({
          ok: false as const,
          reason: 'rate-limited' as const,
          code: undefined,
          message: 'slow down',
        }),
    };
    const path = await completeMobileBrowserSignIn(link, client, VERIFIER);
    expect(path).toBe(mobileHandoffFailedPath('rate-limited'));
  });

  it('says the sign-in expired without a pending verifier', async () => {
    const client = {
      completeDesktopHandoff: () => Promise.reject(new Error('unreachable')),
    };
    const path = await completeMobileBrowserSignIn(link, client, null);
    expect(path).toBe('/login?desktop_handoff=expired');
  });

  it('says the sign-in failed when the exchange throws', async () => {
    const client = {
      completeDesktopHandoff: () => Promise.reject(new Error('offline')),
    };
    const path = await completeMobileBrowserSignIn(link, client, VERIFIER);
    expect(path).toBe('/login?desktop_handoff=failed');
  });
});

describe('startMobileBrowserSignIn', () => {
  beforeEach(() => {
    native.start.mockReset();
    native.close.mockReset();
    native.browserOpen.mockReset();
    native.browserOpen.mockResolvedValue(undefined);
  });

  afterEach(() => {
    native.platform = 'android';
  });

  it('opens a tab on Android and leaves the callback to the app URL', async () => {
    await expect(startMobileBrowserSignIn('standupless')).resolves.toBeNull();
    expect(native.browserOpen).toHaveBeenCalledWith({ url: LAUNCH_URL });
    expect(native.start).not.toHaveBeenCalled();
    expect(hasPendingMobileHandoff()).toBe(true);
  });

  it('answers the callback the iOS session returns', async () => {
    native.platform = 'ios';
    native.start.mockResolvedValue({ url: CALLBACK });
    await expect(startMobileBrowserSignIn('standupless')).resolves.toBe(
      CALLBACK
    );
    expect(native.start).toHaveBeenCalledWith({
      url: LAUNCH_URL,
      callbackScheme: 'standupless',
    });
    expect(native.browserOpen).not.toHaveBeenCalled();
  });

  it('answers nothing when the iOS session was closed for another callback', async () => {
    native.platform = 'ios';
    native.start.mockResolvedValue({});
    await expect(startMobileBrowserSignIn('standupless')).resolves.toBeNull();
  });

  it('falls back to a tab on an iOS build without the plugin', async () => {
    native.platform = 'ios';
    native.start.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'UNIMPLEMENTED' })
    );
    await expect(startMobileBrowserSignIn('standupless')).resolves.toBeNull();
    expect(native.browserOpen).toHaveBeenCalledWith({ url: LAUNCH_URL });
  });

  it('passes on the person closing the iOS sheet', async () => {
    native.platform = 'ios';
    const closed = Object.assign(new Error('closed'), { code: 'cancelled' });
    native.start.mockRejectedValue(closed);
    const outcome = await startMobileBrowserSignIn('standupless').catch(
      (failure: unknown) => failure
    );
    expect(isMobileSignInCancelled(outcome)).toBe(true);
    expect(native.browserOpen).not.toHaveBeenCalled();
  });
});

describe('closeMobileAuthSession', () => {
  beforeEach(() => {
    native.close.mockReset();
    native.close.mockResolvedValue(undefined);
  });

  afterEach(() => {
    native.platform = 'android';
  });

  it('closes the session on iOS and swallows a refusal', async () => {
    native.platform = 'ios';
    native.close.mockRejectedValue(new Error('missing'));
    await expect(closeMobileAuthSession()).resolves.toBeUndefined();
    expect(native.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Android', async () => {
    await closeMobileAuthSession();
    expect(native.close).not.toHaveBeenCalled();
  });
});
