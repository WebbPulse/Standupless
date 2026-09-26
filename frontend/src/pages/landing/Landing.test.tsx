/**
 * The public home page: a logged out visitor sees the hero with both calls to
 * action inside the public shell, whose "Log in" link is the signed out marker
 * the browser suite waits for, and the page carries its own title. A signed in
 * visitor is forwarded to their workspaces.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
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

/** Mounts the page at `/` beside the picker it forwards to. */
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/workspaces" element={<p>Picker</p>} />
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

  it('forwards a signed in visitor to their workspaces', () => {
    useAuthMock.mockReturnValue(session(true));
    renderPage();

    expect(screen.getByText('Picker')).toBeInTheDocument();
  });
});
