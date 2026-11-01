/**
 * The app's sign-in screen holds no credential field, opens the browser, finishes
 * on a callback the browser returned, and always leaves a retry beside the reason
 * a sign-in did not finish.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShellSignIn from './ShellSignIn';

const completeDesktopHandoff = vi.fn();

vi.mock('@webbpulse/auth/react', () => ({
  useAuthClient: () => ({ completeDesktopHandoff }),
}));

vi.mock('../../pages/authentication/AuthLayout', () => ({
  default: ({
    title,
    subtitle,
    children,
  }: {
    title: string;
    subtitle?: string;
    children: React.ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {children}
    </main>
  ),
}));

vi.mock('../../lib/mobileHandoff', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../lib/mobileHandoff')
  >();
  return {
    ...actual,
    isMobileHandoffLink: (url: string) =>
      url.startsWith('standupless://auth/'),
    completeMobileBrowserSignIn: () => Promise.resolve('/workspaces'),
  };
});

const start = vi.fn<() => Promise<string | null>>();

/** Shows the query the screen left, to prove what it kept. */
const Query = () => <p data-testid="query">{useLocation().search}</p>;

/** Mounts the screen at `/login` with a workspaces page to land on. */
const renderScreen = (path = '/login') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/login"
          element={
            <>
              <ShellSignIn start={start} />
              <Query />
            </>
          }
        />
        <Route path="/workspaces" element={<p>workspaces page</p>} />
      </Routes>
    </MemoryRouter>
  );

const openBrowserButton = () => screen.getByTestId('shell-sign-in-browser');

beforeEach(() => {
  start.mockReset();
  start.mockResolvedValue(null);
});

afterEach(() => {
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('ShellSignIn', () => {
  it('offers the browser and no credential field', () => {
    const { container } = renderScreen();
    expect(openBrowserButton()).toHaveTextContent('Continue in browser');
    expect(container.querySelector('input')).toBeNull();
  });

  it('waits with a way to reopen the browser', async () => {
    renderScreen();
    fireEvent.click(openBrowserButton());
    expect(await screen.findByText('Finish in your browser')).toBeInTheDocument();
    expect(openBrowserButton()).toHaveTextContent('Open the browser again');
    expect(openBrowserButton()).toBeEnabled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('finishes on a callback the browser returned', async () => {
    start.mockResolvedValue('standupless://auth/handoff?code=abc');
    renderScreen();
    fireEvent.click(openBrowserButton());
    expect(await screen.findByText('workspaces page')).toBeInTheDocument();
  });

  it('shows the reason a handoff failed beside the retry', () => {
    renderScreen('/login?desktop_handoff=refused');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That account cannot sign in to the app.'
    );
    expect(openBrowserButton()).toHaveTextContent('Continue in browser');
  });

  it('clears the reason and keeps the rest of the query on a retry', async () => {
    renderScreen('/login?desktop_handoff=expired&returnTo=%2Fw%2Facme');
    fireEvent.click(openBrowserButton());
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('query')).toHaveTextContent(
      '?returnTo=%2Fw%2Facme'
    );
  });

  it('says so when the iOS sheet was closed', async () => {
    start.mockRejectedValue(
      Object.assign(new Error('closed'), { code: 'cancelled' })
    );
    renderScreen();
    fireEvent.click(openBrowserButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'closed before the sign-in finished'
    );
    expect(openBrowserButton()).toHaveTextContent('Continue in browser');
  });

  it('says so when the browser could not open', async () => {
    start.mockRejectedValue(new Error('no browser'));
    renderScreen();
    fireEvent.click(openBrowserButton());
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The browser could not be opened.'
    );
  });

  describe('on a desktop build that takes a pasted link', () => {
    const completeSignInLink = vi.fn();

    beforeEach(() => {
      completeSignInLink.mockReset();
      (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
        setBadgeCount: vi.fn(),
        completeSignInLink,
      };
    });

    /** Opens the browser, then pastes a value and submits it. */
    const paste = async (value: string) => {
      renderScreen();
      fireEvent.click(openBrowserButton());
      fireEvent.change(await screen.findByTestId('shell-sign-in-link'), {
        target: { value },
      });
      fireEvent.click(screen.getByTestId('shell-sign-in-link-submit'));
    };

    it('hides the field until the browser has opened', () => {
      renderScreen();
      expect(screen.queryByTestId('shell-sign-in-link')).toBeNull();
    });

    it('passes on a sign-in link', async () => {
      await paste(' standupless://auth/handoff?code=abc ');
      expect(completeSignInLink).toHaveBeenCalledWith(
        'standupless://auth/handoff?code=abc'
      );
    });

    it('refuses anything else without leaving the screen', async () => {
      await paste('https://example.com');
      expect(completeSignInLink).not.toHaveBeenCalled();
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'not a Standupless sign-in link'
      );
      expect(screen.getByTestId('shell-sign-in-link')).toBeInTheDocument();
    });
  });
});
