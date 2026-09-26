/**
 * The public home page: a logged out visitor sees the hero with both calls to
 * action and the page carries its own title, and a signed in visitor is
 * forwarded to their workspaces.
 */

import { render, screen } from '@testing-library/react';
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
      screen.getByRole('heading', { level: 1, name: /without the standup/ })
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

  it('forwards a signed in visitor to their workspaces', () => {
    useAuthMock.mockReturnValue(session(true));
    renderPage();

    expect(screen.getByText('Picker')).toBeInTheDocument();
  });
});
