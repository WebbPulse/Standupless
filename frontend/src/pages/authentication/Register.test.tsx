/**
 * The sign up form says what an account is made under, linking the terms and
 * the privacy policy above the submit button, and offers the OAuth providers.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import Register from './Register';

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

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => null,
  identityOrigin: () => 'https://api.standupless.dev',
}));

vi.mock('../../components/auth/OAuthProviderButtons', () => ({
  default: ({ disabled }: { disabled?: boolean }) => (
    <a
      data-testid="oauth-buttons"
      aria-disabled={disabled ? 'true' : undefined}
    >
      Continue with GitHub
    </a>
  ),
}));

describe('Register', () => {
  it('links the terms and the privacy policy the account is made under', () => {
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    const agreement = screen.getByTestId('register-agreement');
    expect(agreement).toHaveTextContent(
      'By signing up you agree to the Terms of Service and the Privacy Policy.'
    );
    expect(
      within(agreement).getByRole('link', { name: 'Terms of Service' })
    ).toHaveAttribute('href', '/terms');
    expect(
      within(agreement).getByRole('link', { name: 'Privacy Policy' })
    ).toHaveAttribute('href', '/privacy');
  });

  it('offers the OAuth providers below the form behind an or divider', () => {
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );

    const buttons = screen.getByTestId('oauth-buttons');
    expect(buttons).not.toHaveAttribute('aria-disabled');
    const section = buttons.parentElement;
    expect(section).toHaveClass('has-[a]:block');
    expect(section).toHaveTextContent('or');
  });
});
