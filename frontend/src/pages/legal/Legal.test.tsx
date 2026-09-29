/**
 * The privacy policy, the terms and the refund policy render in the public
 * shell with their effective date and contact address, link to each other, and
 * are reachable from the footer on every public page.
 */

import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_GOVERNING_STATE,
} from '../../lib/legal';
import Privacy from './Privacy';
import Refunds from './Refunds';
import Terms from './Terms';

/** The dash the copy style rules out, spelled by code point. */
const EM_DASH = String.fromCharCode(0x2014);

const useAuthMock = vi.fn<() => AuthContextType>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}));

/** Mounts one page inside a router, as a visitor with no session. */
const renderPage = (page: React.ReactElement) =>
  render(<MemoryRouter>{page}</MemoryRouter>);

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

describe('Privacy', () => {
  it('shows the heading, the effective date and the contact address', () => {
    renderPage(<Privacy />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Privacy Policy' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(`Effective ${LEGAL_EFFECTIVE_DATE}`)
    ).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', {
      name: LEGAL_CONTACT_EMAIL,
    })) {
      expect(link).toHaveAttribute('href', `mailto:${LEGAL_CONTACT_EMAIL}`);
    }
    expect(document.title).toBe('Privacy Policy | Standupless');
  });

  it('explains the cookie choice and names the hosting and third parties', () => {
    renderPage(<Privacy />);

    expect(
      screen.getByRole('heading', { name: '5. Cookies and browser storage' })
    ).toBeInTheDocument();
    expect(screen.getByText('wp_refresh')).toBeInTheDocument();
    expect(screen.getByText(/us-west-2/)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '3. The GitHub App' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Terms of Service' })
    ).toHaveAttribute('href', '/terms');
  });

  it('carries the legal links in the public footer', () => {
    renderPage(<Privacy />);

    const footer = screen.getByRole('navigation', { name: 'Legal links' });
    expect(
      within(footer).getByRole('link', { name: 'Privacy' })
    ).toHaveAttribute('href', '/privacy');
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute(
      'href',
      '/terms'
    );
    expect(
      within(footer).getByRole('link', { name: 'Refunds' })
    ).toHaveAttribute('href', '/refunds');
    expect(
      within(footer).getByRole('link', { name: 'Contact' })
    ).toHaveAttribute('href', '/contact');
  });
});

describe('Terms', () => {
  it('shows the heading, the governing law and a link to the privacy policy', () => {
    renderPage(<Terms />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Terms of Service' })
    ).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(`State of\\s+${LEGAL_GOVERNING_STATE}`))
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Privacy Policy' })
    ).toHaveAttribute('href', '/privacy');
  });

  it('states the paid plan terms and links the refund policy', () => {
    renderPage(<Terms />);

    expect(
      screen.getByRole('heading', { name: '7. Plans and payment' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Cancellation and Refund Policy' })
    ).toHaveAttribute('href', '/refunds');
  });

  it('uses no em dashes and never calls anyone a developer', () => {
    const { container: privacy } = renderPage(<Privacy />);
    const { container: terms } = renderPage(<Terms />);
    const { container: refunds } = renderPage(<Refunds />);

    for (const text of [
      privacy.textContent,
      terms.textContent,
      refunds.textContent,
    ]) {
      expect(text).not.toContain(EM_DASH);
      expect(text).not.toMatch(/developer/i);
    }
  });
});

describe('Refunds', () => {
  it('says cancellation is anytime, access runs to the period end and nothing is refunded', () => {
    renderPage(<Refunds />);

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Cancellation and Refund Policy',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '1. Cancel anytime' })
    ).toBeInTheDocument();
    expect(screen.getByText(/billing portal/)).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: '2. Access until the end of the paid period',
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: '3. No refunds' })
    ).toBeInTheDocument();
    expect(document.title).toBe('Cancellation and Refund Policy | Standupless');
  });
});
