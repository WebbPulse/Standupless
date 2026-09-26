/**
 * The behaviour the guards must hold to: a protected guard holds the tree back
 * on `isLoading` and redirects on `!isAuthenticated`, and a guest guard waits on
 * `!isBusy` before bouncing a signed in user away, so a sign in already in
 * flight is not unmounted mid-request. A signed in page renders under the
 * development notice, and nothing else ever shows it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import GuestRoute from './GuestRoute';
import ProtectedRoute from './ProtectedRoute';

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

vi.mock('../layout/DevelopmentBanner', () => ({
  default: () => <div data-testid="development-banner" />,
}));

/** Builds a session value with every flag defaulted to a settled signed-out one. */
const session = (
  overrides: Partial<AuthContextType> = {}
): AuthContextType => ({
  isAuthenticated: false,
  isLoading: false,
  isBusy: false,
  user: null,
  login: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  checkAuthStatus: vi.fn(() => Promise.resolve()),
  ...overrides,
});

/** Mounts a protected route at `/workspaces` with a login page to land on. */
const renderProtected = (initialPath = '/workspaces') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/workspaces" element={<p>workspaces page</p>} />
        </Route>
        <Route path="/login" element={<p>login page</p>} />
      </Routes>
    </MemoryRouter>
  );

/** Mounts a guest route at `initialPath` with a workspaces page to land on. */
const renderGuest = (initialPath = '/login') =>
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route element={<GuestRoute />}>
          <Route path="/login" element={<p>login page</p>} />
        </Route>
        <Route path="/workspaces" element={<p>workspaces page</p>} />
        <Route path="/settings" element={<p>settings page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  useAuthMock.mockReset();
});

describe('ProtectedRoute', () => {
  it('draws a signed in page under the development notice', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderProtected();

    const banner = screen.getByTestId('development-banner');
    const page = screen.getByText('workspaces page');
    expect(
      banner.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('keeps the development notice off the spinner and the redirect', () => {
    useAuthMock.mockReturnValue(session({ isLoading: true }));
    const { unmount } = renderProtected();
    expect(screen.queryByTestId('development-banner')).not.toBeInTheDocument();
    unmount();

    useAuthMock.mockReturnValue(session());
    renderProtected();
    expect(screen.queryByTestId('development-banner')).not.toBeInTheDocument();
  });

  it('shows a spinner while the session has never settled', () => {
    useAuthMock.mockReturnValue(session({ isLoading: true }));
    renderProtected();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('workspaces page')).not.toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('redirects to login once the session settles with no user', () => {
    useAuthMock.mockReturnValue(session());
    renderProtected();

    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('renders the route for a signed in user', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderProtected();

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });

  it('keeps a signed in user mounted while a session call is in flight', () => {
    useAuthMock.mockReturnValue(
      session({ isAuthenticated: true, isBusy: true })
    );
    renderProtected();

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });
});

describe('GuestRoute', () => {
  it('shows a spinner while the session has never settled', () => {
    useAuthMock.mockReturnValue(session({ isLoading: true }));
    renderGuest();

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });

  it('renders the guest page for a signed out visitor', () => {
    useAuthMock.mockReturnValue(session());
    renderGuest();

    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('bounces a settled signed in user to the workspaces list', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderGuest();

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });

  it('holds the login page mounted while a sign in is still in flight', () => {
    useAuthMock.mockReturnValue(
      session({ isAuthenticated: true, isBusy: true })
    );
    renderGuest();

    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('workspaces page')).not.toBeInTheDocument();
  });

  it('honours a same-origin returnTo', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderGuest('/login?returnTo=/settings');

    expect(screen.getByText('settings page')).toBeInTheDocument();
  });

  it('ignores a protocol-relative returnTo', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderGuest('/login?returnTo=//evil.example.com');

    expect(screen.getByText('workspaces page')).toBeInTheDocument();
  });
});
