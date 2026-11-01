/**
 * The sign up form says what an account is made under, linking the terms and
 * the privacy policy above the submit button, and offers the OAuth providers.
 * A new account is signed straight in, and an address that is already taken
 * gets the same neutral "check your email" answer without a session.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ApiError } from '@webbpulse/api-client';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Register from './Register';

const identity = vi.hoisted(() => ({
  client: null as null | {
    signUp: (body: unknown) => Promise<unknown>;
  },
}));

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
  getIdentityClient: () => identity.client,
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

/** Fills the form with a valid new account and submits it. */
const submit = async (): Promise<void> => {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'new@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Display name'), {
    target: { value: 'New' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'a long password' },
  });
  fireEvent.change(screen.getByLabelText('Confirm password'), {
    target: { value: 'a long password' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await Promise.resolve();
  });
};

const renderRegister = () =>
  render(
    <MemoryRouter>
      <Register />
    </MemoryRouter>
  );

beforeEach(() => {
  identity.client = null;
});

describe('Register', () => {
  it('signs up and stays out of the check email page when signed in', async () => {
    const signUp = vi.fn(() =>
      Promise.resolve({ signedIn: true, user: null, expiresIn: 900 })
    );
    identity.client = { signUp };
    renderRegister();

    await submit();

    expect(signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'a long password',
      attributes: { display_name: 'New' },
    });
    expect(
      screen.queryByTestId('register-check-email')
    ).not.toBeInTheDocument();
  });

  it('answers a taken address with a neutral check your email page', async () => {
    identity.client = {
      signUp: () => Promise.resolve({ signedIn: false }),
    };
    renderRegister();

    await submit();

    expect(screen.getByTestId('register-check-email')).toHaveTextContent(
      'If new@example.com can be used for a new account'
    );
  });

  it('shows the reason the server refused the account', async () => {
    identity.client = {
      signUp: () =>
        Promise.reject(
          new ApiError({
            status: 400,
            statusText: 'Bad Request',
            body: {
              error_code: 'PASSWORD_BREACHED',
              message: 'That password has appeared in a data breach.',
            },
            url: '',
            method: 'POST',
          })
        ),
    };
    renderRegister();

    await submit();

    expect(
      screen.getByText('That password has appeared in a data breach.')
    ).toBeInTheDocument();
  });

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
