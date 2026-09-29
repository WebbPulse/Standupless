/**
 * The billing settings page. What matters is who is offered what: any member
 * reads the plan and the storage in use, only an owner or admin is offered
 * Checkout and the portal, and nothing is offered while paid plans are off.
 */

import { ApiError } from '@webbpulse/api-client';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  BillingRead,
  CheckoutCreate,
  StorageUsageRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import BillingSettings from './BillingSettings';

const getBilling = vi.fn<() => Promise<BillingRead>>();
const getStorageUsage = vi.fn<() => Promise<StorageUsageRead>>();
const createCheckoutSession =
  vi.fn<(body: CheckoutCreate) => Promise<string>>();
const createPortalSession = vi.fn<() => Promise<string>>();
const sendBrowserTo = vi.fn<(url: string) => void>();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/billing', () => ({
  getBilling: () => getBilling(),
  getStorageUsage: () => getStorageUsage(),
  createCheckoutSession: (_workspaceId: string, body: CheckoutCreate) =>
    createCheckoutSession(body),
  createPortalSession: () => createPortalSession(),
}));

vi.mock('../../lib/billing', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/billing')>(
      '../../lib/billing'
    );
  return { ...actual, sendBrowserTo: (url: string) => sendBrowserTo(url) };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context with the caller holding `role`. */
const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Engineering',
    slug: 'engineering',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** A plan read in the shape the contract answers with. */
const plan = (over: Partial<BillingRead> = {}): BillingRead => ({
  plan: 'free',
  billing_interval: null,
  subscription_status: null,
  billed_seats: null,
  seats_in_use: 3,
  current_period_end: null,
  cancel_at_period_end: false,
  has_billing_account: false,
  billing_enabled: true,
  business_available: false,
  features: [],
  limits: { teams: 2, members: 10 },
  storage_bytes: 2 * 1024 ** 3,
  guests_per_seat: 0,
  ...over,
});

/** Mounts the page at a URL, which the Checkout return reads. */
const renderPage = (url = '/w/engineering/settings/billing') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <BillingSettings />
    </MemoryRouter>
  );

beforeEach(() => {
  for (const mock of [
    getBilling,
    getStorageUsage,
    createCheckoutSession,
    createPortalSession,
    sendBrowserTo,
  ]) {
    mock.mockReset();
  }
  useWorkspaceMock.mockReset().mockReturnValue(resolved('owner'));
  getBilling.mockResolvedValue(plan());
  getStorageUsage.mockResolvedValue({
    plan: 'free',
    used_bytes: 512 * 1024 ** 2,
    limit_bytes: 2 * 1024 ** 3,
  });
  createCheckoutSession.mockResolvedValue('https://checkout.stripe/x');
  createPortalSession.mockResolvedValue('https://billing.stripe/x');
});

describe('the plan and usage', () => {
  it('shows the plan, the seats and the storage in use to any member', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();

    expect(await screen.findByText('Free')).toBeInTheDocument();
    expect(screen.getByText('3 in use')).toBeInTheDocument();
    expect(screen.getByText('512 MB of 2 GB')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Storage used' })
    ).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByText('Not included')).toBeInTheDocument();
    expect(
      screen.getByText('A workspace owner or admin can upgrade the plan.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Upgrade to/ })
    ).not.toBeInTheDocument();
  });

  it('shows a paid subscription with its renewal and billed seats', async () => {
    getBilling.mockResolvedValue(
      plan({
        plan: 'standard',
        billing_interval: 'year',
        subscription_status: 'active',
        billed_seats: 5,
        current_period_end: '2027-09-17T00:00:00Z',
        has_billing_account: true,
        guests_per_seat: 5,
        features: ['guests', 'triage'],
      })
    );
    renderPage();

    expect(await screen.findByText('Standard')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Billed annually')).toBeInTheDocument();
    expect(screen.getByText('3 in use of 5 billed')).toBeInTheDocument();
    expect(screen.getByText('Renews')).toBeInTheDocument();
    expect(screen.getByText('15 (5 per seat)')).toBeInTheDocument();
    expect(screen.getByText('Includes Guests, Triage.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Upgrade to/ })
    ).not.toBeInTheDocument();
  });

  it('explains the preview limits while paid plans are off', async () => {
    getBilling.mockResolvedValue(plan({ billing_enabled: false }));
    renderPage();

    expect(
      await screen.findByText(/Paid plans are not on sale yet/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Upgrade to/ })
    ).not.toBeInTheDocument();
  });

  it('shows the server sentence when the plan cannot be read', async () => {
    getBilling.mockRejectedValue(
      new ApiError({
        status: 500,
        statusText: 'Server Error',
        body: null,
        url: '/api/workspaces/ws-1/billing',
        method: 'GET',
      })
    );
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('upgrading', () => {
  it('sends an admin to Checkout for the chosen plan and interval', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'Upgrade to Standard' });
    expect(
      screen.getByText('$6 per seat per month, billed annually')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Monthly' }));
    expect(
      screen.getByText('$8 per seat per month, billed monthly')
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Upgrade to Standard' })
    );

    expect(createCheckoutSession).toHaveBeenCalledWith({
      plan: 'standard',
      interval: 'month',
    });
    expect(sendBrowserTo).toHaveBeenCalledWith('https://checkout.stripe/x');
  });

  it('holds Business back until it is on sale', async () => {
    renderPage();

    const business = await screen.findByRole('button', {
      name: 'Upgrade to Business',
    });
    expect(business).toBeDisabled();
    expect(
      within(business.closest('li') as HTMLElement).getByText('Coming soon')
    ).toBeInTheDocument();
  });

  it('shows a refused Checkout and lets the admin try again', async () => {
    createCheckoutSession.mockRejectedValue(
      new ApiError({
        status: 503,
        statusText: 'Service Unavailable',
        body: {
          error_code: 'STRIPE_PRICE_MISSING',
          message: 'That plan has no price configured',
        },
        url: '/api/workspaces/ws-1/billing/checkout-session',
        method: 'POST',
      })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Upgrade to Standard' })
    );

    expect(
      await screen.findByText('That plan has no price configured')
    ).toBeInTheDocument();
    expect(sendBrowserTo).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Upgrade to Standard' })
    ).toBeEnabled();
  });
});

describe('the portal and the Checkout return', () => {
  it('opens the portal for an admin of a workspace with a billing account', async () => {
    getBilling.mockResolvedValue(
      plan({ plan: 'standard', has_billing_account: true })
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Manage billing' })
    );

    expect(sendBrowserTo).toHaveBeenCalledWith('https://billing.stripe/x');
  });

  it('offers no portal to a member', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    getBilling.mockResolvedValue(
      plan({ plan: 'standard', has_billing_account: true })
    );
    renderPage();

    await screen.findByText('Standard');
    expect(
      screen.queryByRole('button', { name: 'Manage billing' })
    ).not.toBeInTheDocument();
  });

  it('thanks the admin on the way back from a paid Checkout', async () => {
    renderPage('/w/engineering/settings/billing?checkout=success');

    expect(await screen.findByText(/Thanks for upgrading/)).toBeInTheDocument();
  });

  it('says nothing was charged on the way back from a cancelled one', async () => {
    renderPage('/w/engineering/settings/billing?checkout=cancelled');

    expect(
      await screen.findByText('Checkout was cancelled. Nothing was charged.')
    ).toBeInTheDocument();
  });
});
