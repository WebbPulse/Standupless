/**
 * The customers list. Covers that rows show a customer's domains, tier, size,
 * revenue and request count and link to its page, that the request column
 * sorts the busiest customer first, that search narrows by domain, that a
 * member creates a customer and lands on it, and that a guest is told
 * customers are for members.
 */

import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CustomerCreate,
  CustomerRead,
  MemberRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import Customers from './Customers';

const listCustomers = vi.fn<() => Promise<CustomerRead[]>>();
const createCustomer = vi.fn<(body: CustomerCreate) => Promise<CustomerRead>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();

vi.mock('../../api/customers', () => ({
  listCustomers: () => listCustomers(),
  createCustomer: (_w: string, body: CustomerCreate) => createCustomer(body),
  updateCustomer: vi.fn(),
}));

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return { ...actual, listMembers: () => listMembers() };
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

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    title,
    actions,
    children,
  }: {
    title?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** Builds a customer with no optional fields set. */
const customer = (
  id: string,
  name: string,
  overrides: Partial<CustomerRead> = {}
): CustomerRead => ({
  customer_id: id,
  workspace_id: 'ws-1',
  name,
  domains: [],
  tier: null,
  owner_id: null,
  revenue: null,
  size: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  request_count: 0,
  can_edit: true,
  can_delete: true,
  ...overrides,
});

const resolved = (role: WorkspaceRole): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/customers']}>
      <Routes>
        <Route path="/w/:slug/customers" element={<Customers />} />
        <Route
          path="/w/:slug/customers/:customerId"
          element={<p>customer page</p>}
        />
      </Routes>
    </MemoryRouter>
  );

describe('Customers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listMembers.mockResolvedValue([]);
    listCustomers.mockResolvedValue([]);
  });

  it('lists customers with their fields and links each to its page', async () => {
    listCustomers.mockResolvedValue([
      customer('cus-1', 'Acme', {
        domains: ['acme.com'],
        tier: 'Enterprise',
        size: 1200,
        revenue: 2500000,
        request_count: 3,
      }),
    ]);
    renderPage();

    const link = await screen.findByRole('link', { name: 'Acme' });
    expect(link).toHaveAttribute('href', '/w/mine/customers/cus-1');
    const list = screen.getByRole('list', { name: 'Customers' });
    expect(within(list).getByText('acme.com')).toBeInTheDocument();
    expect(within(list).getByText('Enterprise')).toBeInTheDocument();
    expect(within(list).getByText('1.2K')).toBeInTheDocument();
    expect(within(list).getByText('$2.5M')).toBeInTheDocument();
    expect(within(list).getByText('3 requests')).toBeInTheDocument();
  });

  it('sorts the customer with the most requests first', async () => {
    listCustomers.mockResolvedValue([
      customer('cus-1', 'Acme', { request_count: 1 }),
      customer('cus-2', 'Globex', { request_count: 5 }),
    ]);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('link', { name: 'Acme' });
    await user.click(screen.getByRole('button', { name: 'Sort by requests' }));

    const links = within(
      screen.getByRole('list', { name: 'Customers' })
    ).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([
      'Globex',
      'Acme',
    ]);
  });

  it('narrows the list by domain', async () => {
    listCustomers.mockResolvedValue([
      customer('cus-1', 'Acme', { domains: ['acme.com'] }),
      customer('cus-2', 'Globex', { domains: ['globex.io'] }),
    ]);
    const user = userEvent.setup();
    renderPage();

    await user.type(
      await screen.findByRole('searchbox', { name: 'Search customers' }),
      'globex'
    );

    expect(
      screen.queryByRole('link', { name: 'Acme' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Globex' })).toBeInTheDocument();
  });

  it('creates a customer and opens it', async () => {
    createCustomer.mockResolvedValue(customer('cus-9', 'Initech'));
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'New customer' })
    );
    await user.type(screen.getByLabelText('Customer name'), 'Initech');
    await user.type(
      screen.getByLabelText('Domains'),
      'initech.com, initech.io'
    );
    await user.click(screen.getByRole('button', { name: 'Create customer' }));

    await waitFor(() => {
      expect(createCustomer).toHaveBeenCalledWith({
        name: 'Initech',
        domains: ['initech.com', 'initech.io'],
        tier: null,
        owner_id: null,
        revenue: null,
        size: null,
      });
    });
    expect(await screen.findByText('customer page')).toBeInTheDocument();
  });

  it('tells a guest customers are for members', () => {
    useWorkspaceMock.mockReturnValue(resolved('guest'));
    renderPage();

    expect(
      screen.getByText('Customers are open to workspace members, not guests.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New customer' })
    ).not.toBeInTheDocument();
    expect(listCustomers).not.toHaveBeenCalled();
  });
});
