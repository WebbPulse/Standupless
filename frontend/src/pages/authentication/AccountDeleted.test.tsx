/**
 * The signed out page after an account deletion confirms it without offering
 * anything to undo.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import AccountDeleted from './AccountDeleted';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    isBusy: false,
    user: null,
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

describe('AccountDeleted', () => {
  it('confirms the deletion and links home', () => {
    render(
      <MemoryRouter>
        <AccountDeleted />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', { name: 'Your account was deleted' })
    ).toBeInTheDocument();
    expect(screen.getByText(/signed out on every device/)).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Back to the home page' })
    ).toHaveAttribute('href', '/');
    expect(screen.queryByText(/cancel/i)).not.toBeInTheDocument();
  });
});
