/**
 * The public frame carries the site's bar and footer in a browser, and only
 * the wordmark inside the desktop or mobile app.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PublicShell from './PublicShell';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    isBusy: false,
    user: null,
  }),
}));

/** Mounts the frame around a placeholder page. */
const renderShell = () =>
  render(
    <MemoryRouter>
      <PublicShell>
        <p>page body</p>
      </PublicShell>
    </MemoryRouter>
  );

afterEach(() => {
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('PublicShell', () => {
  it('carries the section links and the footer in a browser', () => {
    renderShell();
    expect(
      screen.getByRole('navigation', { name: 'Product' })
    ).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('drops the marketing links and the footer in the desktop app', () => {
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      platform: 'darwin',
      setBadgeCount: vi.fn(),
    };
    renderShell();
    expect(screen.getByText('page body')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    expect(screen.queryByText('Pricing')).not.toBeInTheDocument();
  });
});
