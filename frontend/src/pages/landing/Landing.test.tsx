/**
 * The public home page: a logged out visitor sees the hero with both calls to
 * action inside the public shell, whose "Log in" link is the signed out marker
 * the browser suite waits for, and the page carries its own title. A signed in
 * visitor is forwarded to their workspaces, asking the picker to resume the
 * last one opened, unless they asked for the page with `?landing`, and the
 * page stays up unmarked while the session is still being read.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import { wantsResume } from '../../lib/lastWorkspace';
import Landing, { LANDING_TITLE } from './Landing';

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

/** A settled session, signed in or not. */
const session = (isAuthenticated: boolean): AuthContextType => ({
  isAuthenticated,
  isLoading: false,
  isBusy: false,
  user: null,
  login: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  checkAuthStatus: vi.fn(() => Promise.resolve()),
});

/** Stands in for the picker, showing whether it was asked to resume. */
const Picker = () => {
  const location = useLocation();
  return <p>{wantsResume(location.state) ? 'Picker resuming' : 'Picker'}</p>;
};

/** Mounts the page at `entry` beside the picker it forwards to. */
const renderPage = (entry = '/') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/workspaces" element={<Picker />} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  useAuthMock.mockReset();
});

describe('Landing', () => {
  it('shows the hero and both calls to action to a visitor', () => {
    useAuthMock.mockReturnValue(session(false));
    renderPage();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Issues, cycles and projects for software teams',
      })
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('link', { name: 'Get started' })[0]
    ).toHaveAttribute('href', '/register');
    expect(screen.getAllByRole('link', { name: 'Log in' })[0]).toHaveAttribute(
      'href',
      '/login'
    );
    expect(document.title).toBe(LANDING_TITLE);
  });

  it('carries the public bar with the signed out marker on its log in link', () => {
    useAuthMock.mockReturnValue(session(false));
    renderPage();

    const bar = screen.getByRole('banner');
    expect(within(bar).getByTestId('signed-out')).toHaveAttribute(
      'href',
      '/login'
    );
    expect(within(bar).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
      'href',
      '/register'
    );
    expect(within(bar).getByRole('link', { name: 'Features' })).toHaveAttribute(
      'href',
      '/#features'
    );
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('keeps the page up without the signed out marker while the session loads', () => {
    useAuthMock.mockReturnValue({ ...session(false), isLoading: true });
    renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('signed-out')).toBeNull();
    expect(
      within(screen.getByRole('banner')).getByRole('link', { name: 'Log in' })
    ).toHaveAttribute('href', '/login');
  });

  it('forwards a signed in visitor to their workspaces to resume the last one', () => {
    useAuthMock.mockReturnValue(session(true));
    renderPage();

    expect(screen.getByText('Picker resuming')).toBeInTheDocument();
  });

  it('holds the redirect while a sign in or sign out is in flight', () => {
    useAuthMock.mockReturnValue({ ...session(true), isBusy: true });
    renderPage();

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Picker/)).toBeNull();
  });

  it('shows a signed in visitor the page when asked for it with ?landing', () => {
    useAuthMock.mockReturnValue(session(true));
    renderPage('/?landing');

    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Picker/)).toBeNull();
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('link', { name: /Open app/ })).toHaveAttribute(
      'href',
      '/workspaces'
    );
    expect(
      within(bar).getByRole('link', { name: 'Standupless home' })
    ).toHaveAttribute('href', '/?landing');
    expect(within(bar).getByRole('link', { name: 'Features' })).toHaveAttribute(
      'href',
      '/?landing#features'
    );
  });

  it('shows a visitor the MCP server address and the CLI install command', () => {
    useAuthMock.mockReturnValue(session(false));
    renderPage();

    const mcp = document.getElementById('mcp');
    const cli = document.getElementById('cli');
    expect(mcp).not.toBeNull();
    expect(cli).not.toBeNull();
    expect(
      within(mcp as HTMLElement).getByText(/\/api\/mcp$/)
    ).toBeInTheDocument();
    expect(
      within(cli as HTMLElement).getByText(/pip install standupless-cli/)
    ).toBeInTheDocument();
  });
});
