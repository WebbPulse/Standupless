/**
 * The pricing page shows every plan with both billing intervals in the markup,
 * sends the plan not yet on sale to the contact page, links the refund policy
 * and keeps to the copy rules.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import Pricing, { PRICING_TITLE } from './Pricing';

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

/** Mounts the page inside a router, as a visitor with no session. */
const renderPage = () =>
  render(
    <MemoryRouter>
      <Pricing />
    </MemoryRouter>
  );

/** The card for one plan, found by its heading. */
const card = (name: string): HTMLElement =>
  screen.getByRole('listitem', { name });

beforeEach(() => {
  useAuthMock.mockReset();
  useAuthMock.mockReturnValue({
    isAuthenticated: false,
    isLoading: false,
    isBusy: false,
    user: null,
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  });
});

describe('Pricing', () => {
  it('prints the annual and monthly price of every plan', () => {
    renderPage();

    expect(within(card('Free')).getByText('$0')).toBeInTheDocument();
    expect(within(card('Standard')).getByText('$6')).toBeInTheDocument();
    expect(
      within(card('Standard')).getByText('or $8 per seat billed monthly')
    ).toBeInTheDocument();
    expect(within(card('Business')).getByText('$10')).toBeInTheDocument();
    expect(
      within(card('Business')).getByText('or $12 per seat billed monthly')
    ).toBeInTheDocument();
    expect(document.title).toBe(PRICING_TITLE);
  });

  it('sends Free and Standard to sign up and Business to the contact page', () => {
    renderPage();

    expect(
      within(card('Free')).getByRole('link', { name: 'Get started' })
    ).toHaveAttribute('href', '/register');
    expect(
      within(card('Standard')).getByRole('link', { name: 'Get started' })
    ).toHaveAttribute('href', '/register');
    expect(
      within(card('Business')).getByText('Coming soon')
    ).toBeInTheDocument();
    expect(
      within(card('Business')).getByRole('link', { name: 'Contact us' })
    ).toHaveAttribute('href', '/contact');
  });

  it('answers the cancellation question with a link to the refund policy', () => {
    const { container } = renderPage();

    expect(
      screen.getByRole('link', { name: 'cancellation and refund policy' })
    ).toHaveAttribute('href', '/refunds');
    expect(container.textContent).not.toContain(String.fromCharCode(0x2014));
    expect(container.textContent).not.toMatch(/developer/i);
  });
});
