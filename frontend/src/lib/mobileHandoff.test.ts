/**
 * The mobile browser sign-in: the verifier kept on the device, and the path the
 * page goes to once a handoff settles. The store's own rules are tested with
 * the shared package.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeMobileAuthSession,
  completeMobileBrowserSignIn,
  isMobileSignInCancelled,
  MOBILE_HANDOFF_STORAGE_KEY,
  mobileBrowserSignIn,
  mobileHandoffFailedPath,
  mobileHandoffScheme,
  mobileHandoffVerifier,
  startMobileBrowserSignIn,
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
  it('is kept in local storage, so a stopped app can still finish', () => {
    mobileHandoffVerifier.keep(VERIFIER, 1000);
    expect(localStorage.getItem(MOBILE_HANDOFF_STORAGE_KEY)).not.toBeNull();
    expect(mobileHandoffVerifier.take(2000)).toBe(VERIFIER);
    expect(localStorage.getItem(MOBILE_HANDOFF_STORAGE_KEY)).toBeNull();
  });

  it('offers a retry for an entry of the old shape', async () => {
    localStorage.setItem(
      MOBILE_HANDOFF_STORAGE_KEY,
      JSON.stringify({ verifier: VERIFIER, startedAt: Date.now() })
    );
    expect(mobileHandoffVerifier.hasPending()).toBe(true);
    const client = {
      completeDesktopHandoff: () => Promise.reject(new Error('unreachable')),
    };
    await expect(completeMobileBrowserSignIn(CALLBACK, client)).resolves.toBe(
      '/login?desktop_handoff=expired'
    );
    expect(mobileHandoffVerifier.hasPending()).toBe(false);
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
    expect(mobileHandoffVerifier.hasPending()).toBe(true);
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
