/**
 * Inside the desktop or mobile app, `/` starts on sign in or the workspace and
 * a public page goes to the system browser; in a browser both stay the web.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import { ShellPublicRoute, ShellStart } from './ShellRoutes';

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
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

const openExternal = vi.fn<(url: string) => void>();

/** Puts a desktop bridge on the window, as the desktop preload does. */
const enterDesktopApp = (): void => {
  (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
    platform: 'linux',
    version: '0.1.0',
    passkeys: false,
    setBadgeCount: vi.fn(),
    notify: vi.fn(),
    setTheme: vi.fn(),
    onNavigate: vi.fn(() => () => undefined),
    openExternal,
  };
};

/** Shows the path and whether the resume state came along. */
const Where = ({ name }: { name: string }) => {
  const location = useLocation();
  const resume =
    (location.state as { resume?: boolean } | null)?.resume === true;
  return <p>{`${name}${resume ? ' resume' : ''}`}</p>;
};

/** Mounts the start route at `/` and the public route at `/pricing`. */
const renderRoutes = (entries: string[]) =>
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/" element={<ShellStart />} />
        <Route element={<ShellPublicRoute />}>
          <Route path="/pricing" element={<p>pricing page</p>} />
        </Route>
        <Route path="/login" element={<Where name="login page" />} />
        <Route path="/workspaces" element={<Where name="workspaces page" />} />
        <Route path="/w/acme" element={<p>workspace page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  useAuthMock.mockReset();
  openExternal.mockReset();
});

afterEach(() => {
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('ShellStart', () => {
  it('starts a signed out person on sign in', () => {
    useAuthMock.mockReturnValue(session());
    renderRoutes(['/']);
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('resumes the last workspace for someone signed in', () => {
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderRoutes(['/']);
    expect(screen.getByText('workspaces page resume')).toBeInTheDocument();
  });

  it('holds on the cold start screen until the session settles', () => {
    useAuthMock.mockReturnValue(session({ isLoading: true }));
    renderRoutes(['/']);
    expect(screen.queryByText('login page')).not.toBeInTheDocument();
  });
});

describe('ShellPublicRoute', () => {
  it('renders the public page in a browser', () => {
    useAuthMock.mockReturnValue(session());
    renderRoutes(['/pricing']);
    expect(screen.getByText('pricing page')).toBeInTheDocument();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens the page in the system browser and steps back in the app', async () => {
    enterDesktopApp();
    useAuthMock.mockReturnValue(session({ isAuthenticated: true }));
    renderRoutes(['/w/acme', '/pricing']);
    expect(await screen.findByText('workspace page')).toBeInTheDocument();
    expect(screen.queryByText('pricing page')).not.toBeInTheDocument();
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      `${window.location.origin}/pricing`
    );
  });

  it('falls back to the start when the public page was the first one loaded', async () => {
    enterDesktopApp();
    useAuthMock.mockReturnValue(session());
    render(
      <MemoryRouter initialEntries={['/pricing']}>
        <Routes>
          <Route path="/" element={<ShellStart />} />
          <Route element={<ShellPublicRoute />}>
            <Route path="/pricing" element={<p>pricing page</p>} />
          </Route>
          <Route path="/login" element={<p>login page</p>} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
