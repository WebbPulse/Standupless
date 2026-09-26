/**
 * The development notice shows on every new session: a dismissal hides it for
 * the rest of that session, survives a remount, and lapses on the sign-out
 * before the next sign-in.
 */

import { act, render, screen } from '@testing-library/react';
import type { AuthState } from '@webbpulse/auth';
import { AuthProvider, type AnyAuthClient } from '@webbpulse/auth/react';
import { afterEach, describe, expect, it } from 'vitest';
import DevelopmentBanner from './DevelopmentBanner';

/** A stub client whose state a test moves by hand, notifying subscribers. */
function stubClient(initial: Partial<AuthState<unknown>>): {
  client: AnyAuthClient;
  move: (next: Partial<AuthState<unknown>>) => void;
} {
  let state: AuthState<unknown> = {
    status: 'unknown',
    user: null,
    hasAccessToken: false,
    error: null,
    sessionEnded: null,
    pendingMfa: null,
    settled: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const client = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AnyAuthClient;
  const move = (next: Partial<AuthState<unknown>>): void => {
    state = { ...state, ...next };
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  };
  return { client, move };
}

const SIGNED_IN: Partial<AuthState<unknown>> = {
  status: 'authenticated',
  hasAccessToken: true,
  settled: true,
};

const SIGNED_OUT: Partial<AuthState<unknown>> = {
  status: 'anonymous',
  hasAccessToken: false,
  settled: true,
};

/** Mounts the banner under the package provider fed by `client`. */
const renderBanner = (client: AnyAuthClient) =>
  render(
    <AuthProvider client={client} initializeOnMount={false}>
      <DevelopmentBanner />
    </AuthProvider>
  );

afterEach(() => {
  sessionStorage.clear();
});

describe('DevelopmentBanner', () => {
  it('says the product is in development without promising data resets', () => {
    const { client } = stubClient(SIGNED_IN);
    renderBanner(client);

    const banner = screen.getByTestId('development-banner');
    expect(banner).toHaveTextContent('Standupless is in development.');
    expect(banner.textContent).not.toMatch(/wipe|reset|\u2014/i);
    expect(screen.getByRole('link', { name: /@/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/^mailto:/)
    );
  });

  it('stays dismissed across a remount in the same session', () => {
    const { client } = stubClient(SIGNED_IN);
    const first = renderBanner(client);

    act(() => {
      screen.getByRole('button', { name: 'Dismiss notice' }).click();
    });
    expect(screen.queryByTestId('development-banner')).not.toBeInTheDocument();
    first.unmount();

    renderBanner(client);
    expect(screen.queryByTestId('development-banner')).not.toBeInTheDocument();
  });

  it('shows again after a sign-out and the next sign-in', () => {
    const { client, move } = stubClient(SIGNED_IN);
    renderBanner(client);
    act(() => {
      screen.getByRole('button', { name: 'Dismiss notice' }).click();
    });

    move(SIGNED_OUT);
    move({ status: 'loading', hasAccessToken: false });
    move(SIGNED_IN);

    expect(screen.getByTestId('development-banner')).toBeInTheDocument();
  });
});
