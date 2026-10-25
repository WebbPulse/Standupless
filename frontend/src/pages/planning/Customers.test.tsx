/**
 * The customers list. Covers that rows show a customer's domains, tier, size,
 * revenue and request count and link to its page, that the request column
 * sorts the busiest customer first, that search narrows by domain, that a
 * member creates a customer and lands on it, and that a guest is told
 * customers are for members. The keyboard tests cover J, K, Escape and Enter,
 * X selecting, S opening the focused row's status picker, the row menu naming
 * the keys, and Cmd/Ctrl+Backspace asking to delete only what the caller may.
 */

import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CustomerCreate,
  CustomerPatch,
  CustomerRead,
  MemberRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import Customers from './Customers';

const listCustomers = vi.fn<() => Promise<CustomerRead[]>>();
const createCustomer = vi.fn<(body: CustomerCreate) => Promise<CustomerRead>>();
const listMembers = vi.fn<() => Promise<MemberRead[]>>();
const updateCustomer =
  vi.fn<(id: string, body: CustomerPatch) => Promise<CustomerRead>>();
const deleteCustomer = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/customers', () => ({
  listCustomers: () => listCustomers(),
  createCustomer: (_w: string, body: CustomerCreate) => createCustomer(body),
  updateCustomer: (_w: string, id: string, body: CustomerPatch) =>
    updateCustomer(id, body),
  deleteCustomer: (_w: string, id: string) => deleteCustomer(id),
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
  status: null,
  tier: null,
  owner_id: null,
  revenue: null,
  size: null,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  request_count: 0,
  important_count: 0,
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
        status: null,
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

/** Renders the list inside the shortcut registry, the way the shell does. */
const renderWithShortcuts = () =>
  render(
    <ShortcutProvider>
      <MemoryRouter initialEntries={['/w/mine/customers']}>
        <Routes>
          <Route path="/w/:slug/customers" element={<Customers />} />
          <Route
            path="/w/:slug/customers/:customerId"
            element={<p>customer page</p>}
          />
        </Routes>
      </MemoryRouter>
    </ShortcutProvider>
  );

/** The row of the customer with this name. */
const rowOf = (name: string): HTMLElement => {
  const row = screen.getByRole('link', { name }).closest('li');
  if (row === null) throw new Error(`No row for ${name}`);
  return row;
};

describe('Customers from the keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceMock.mockReturnValue(resolved('member'));
    listMembers.mockResolvedValue([]);
    listCustomers.mockResolvedValue([
      customer('cus-1', 'Acme'),
      customer('cus-2', 'Globex', { can_edit: false, can_delete: false }),
    ]);
    updateCustomer.mockImplementation((id, body) =>
      Promise.resolve({ ...customer(id, 'Acme'), ...body })
    );
    deleteCustomer.mockResolvedValue(undefined);
  });

  it('highlights with J and K, clears with Escape and opens with Enter', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.keyboard('j');
    expect(rowOf('Acme')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('j');
    expect(rowOf('Acme')).not.toHaveAttribute('aria-current');
    expect(rowOf('Globex')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('k');
    expect(rowOf('Acme')).toHaveAttribute('aria-current', 'true');

    await user.keyboard('{Escape}');
    expect(rowOf('Acme')).not.toHaveAttribute('aria-current');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(await screen.findByText('customer page')).toBeInTheDocument();
  });

  it('selects the focused customer with X and lets go with Escape', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.keyboard('jx');
    expect(screen.getByRole('checkbox', { name: 'Select Acme' })).toBeChecked();
    expect(rowOf('Acme')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.getByRole('checkbox', { name: 'Select Acme' })
      ).not.toBeChecked();
    });
  });

  it('opens the focused customer status picker with S and saves the pick', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.keyboard('js');
    const menu = await screen.findByRole('menu', { name: 'Customer status' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Active' }));

    await waitFor(() => {
      expect(updateCustomer).toHaveBeenCalledWith('cus-1', {
        status: 'active',
      });
    });
  });

  it('leaves S alone on a customer the caller may not edit', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Globex' });

    await user.keyboard('jjs');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      screen.queryByRole('menu', { name: 'Customer status' })
    ).not.toBeInTheDocument();
  });

  it('names the keys in the row menu', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.click(screen.getByRole('button', { name: 'Actions for Acme' }));
    const menu = screen.getByRole('menu', { name: 'Actions for Acme' });
    expect(
      within(menu).getByRole('menuitem', { name: /Change status/ })
    ).toHaveTextContent('S');
    expect(
      within(menu).getByRole('menuitem', { name: /Change owner/ })
    ).toHaveTextContent('A');
    expect(
      within(menu).getByRole('menuitem', { name: /Change tier/ })
    ).toHaveTextContent('T');
    expect(
      within(menu).getByRole('menuitem', { name: /Delete/ })
    ).toBeInTheDocument();
  });

  it('asks before deleting the focused customer, and only when the caller may', async () => {
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.keyboard('j{Control>}{Backspace}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Delete Acme' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteCustomer).toHaveBeenCalledWith('cus-1');
    });

    deleteCustomer.mockClear();
    await user.hover(rowOf('Globex'));
    await user.keyboard('{Control>}{Backspace}{/Control}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteCustomer).not.toHaveBeenCalled();
  });

  it('deletes every selected customer it may after one confirm', async () => {
    listCustomers.mockResolvedValue([
      customer('cus-1', 'Acme'),
      customer('cus-3', 'Initech'),
    ]);
    const user = userEvent.setup();
    renderWithShortcuts();
    await screen.findByRole('link', { name: 'Acme' });

    await user.click(screen.getByRole('checkbox', { name: 'Select Acme' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Initech' }));
    await user.keyboard('{Control>}{Backspace}{/Control}');
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete 2 customers',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(deleteCustomer).toHaveBeenCalledTimes(2);
    });
    expect(deleteCustomer).toHaveBeenCalledWith('cus-1');
    expect(deleteCustomer).toHaveBeenCalledWith('cus-3');
  });
});
