/**
 * The provider buttons: one real anchor per offered provider, Apple labelled and
 * coloured as Apple's button rules ask, and nothing when none is offered.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import OAuthProviderButtons from './OAuthProviderButtons';

let providers: { id: string; displayName: string }[] = [];

vi.mock('@webbpulse/discovery/react', () => ({
  useOAuthProviders: () => providers,
}));

vi.mock('../../api/identityClient', () => ({
  identityOrigin: () => 'https://api.example.com',
  getIdentityClient: () => ({
    oauthStartUrl: (provider: string) =>
      `https://api.example.com/api/auth/oauth/${provider}/start`,
  }),
}));

beforeEach(() => {
  providers = [
    { id: 'google', displayName: 'Google' },
    { id: 'github', displayName: 'GitHub' },
    { id: 'apple', displayName: 'Apple' },
  ];
});

describe('OAuthProviderButtons', () => {
  it('links Continue with Apple to the start route', () => {
    render(<OAuthProviderButtons />);
    expect(
      screen.getByRole('link', { name: 'Continue with Apple' })
    ).toHaveAttribute(
      'href',
      'https://api.example.com/api/auth/oauth/apple/start'
    );
  });

  it('draws the Apple button black on light and white on dark', () => {
    render(<OAuthProviderButtons />);
    const apple = screen.getByRole('link', { name: 'Continue with Apple' });
    expect(apple).toHaveClass('bg-black', 'text-white', 'dark:bg-white');
    expect(apple.querySelector('svg')).not.toBeNull();
  });

  it('keeps the other providers on the neutral button', () => {
    render(<OAuthProviderButtons />);
    const google = screen.getByRole('link', { name: 'Continue with Google' });
    expect(google).toHaveClass('bg-bg', 'text-text');
    expect(google).not.toHaveClass('bg-black');
  });

  it('renders nothing when the deployment offers no provider', () => {
    providers = [];
    const { container } = render(<OAuthProviderButtons />);
    expect(container).toBeEmptyDOMElement();
  });
});
