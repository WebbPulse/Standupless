/**
 * The workspace Customers settings page: the customer statuses and tiers. An
 * admin adds, reorders and deletes entries, a delete of an entry customers
 * hold moving them onto a chosen replacement, and a member sees both lists
 * with nothing to edit.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomerFieldKind } from '../../api/customers';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  CustomerFieldCreate,
  CustomerFieldRead,
  CustomerFieldUpdate,
  WorkspaceRole,
} from '../../types/Api';
import CustomersSettings from './CustomersSettings';

const listCustomerFields =
  vi.fn<(kind: CustomerFieldKind) => Promise<CustomerFieldRead[]>>();
const createCustomerField =
  vi.fn<
    (
      kind: CustomerFieldKind,
      body: CustomerFieldCreate
    ) => Promise<CustomerFieldRead>
  >();
const updateCustomerField =
  vi.fn<
    (
      kind: CustomerFieldKind,
      id: string,
      body: CustomerFieldUpdate
    ) => Promise<CustomerFieldRead>
  >();
const deleteCustomerField =
  vi.fn<
    (
      kind: CustomerFieldKind,
      id: string,
      replacementId?: string
    ) => Promise<void>
  >();

vi.mock('../../api/customers', () => ({
  listCustomerFields: (_w: string, kind: CustomerFieldKind) =>
    listCustomerFields(kind),
  createCustomerField: (
    _w: string,
    kind: CustomerFieldKind,
    body: CustomerFieldCreate
  ) => createCustomerField(kind, body),
  updateCustomerField: (
    _w: string,
    kind: CustomerFieldKind,
    id: string,
    body: CustomerFieldUpdate
  ) => updateCustomerField(kind, id, body),
  deleteCustomerField: (
    _w: string,
    kind: CustomerFieldKind,
    id: string,
    replacementId?: string
  ) => deleteCustomerField(kind, id, replacementId),
}));

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
const resolved = (role: WorkspaceRole): WorkspaceContextType => ({
  workspace: {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role,
  },
  isLoading: false,
  notFound: false,
  error: null,
  refresh: vi.fn(() => Promise.resolve()),
});

/** One entry as the API answers it. */
const entry = (
  id: string,
  name: string,
  position: number,
  count = 0
): CustomerFieldRead => ({
  id,
  name,
  color: null,
  position,
  customer_count: count,
  created_at: '2026-10-25T00:00:00Z',
  updated_at: '2026-10-25T00:00:00Z',
});

const statuses = [
  entry('lead', 'Lead', 0),
  entry('active', 'Active', 1, 4),
  entry('churned', 'Churned', 2),
];
const tiers = [
  entry('tier-1', 'Startup', 0, 2),
  entry('tier-2', 'Enterprise', 1),
];

beforeEach(() => {
  vi.clearAllMocks();
  listCustomerFields.mockImplementation((kind) =>
    Promise.resolve(kind === 'statuses' ? statuses : tiers)
  );
  createCustomerField.mockImplementation((_kind, body) =>
    Promise.resolve(entry('new', body.name, 2))
  );
  updateCustomerField.mockResolvedValue(tiers[1]!);
  deleteCustomerField.mockResolvedValue(undefined);
  useWorkspaceMock.mockReturnValue(resolved('owner'));
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/settings/customers']}>
      <CustomersSettings />
    </MemoryRouter>
  );

describe('the customers settings page', () => {
  it('lists statuses and tiers with their counts', async () => {
    renderPage();
    const tierList = await screen.findByRole('region', { name: 'Tiers' });
    expect(
      await within(tierList).findByDisplayValue('Startup')
    ).toBeInTheDocument();
    expect(within(tierList).getByText('2 customers')).toBeInTheDocument();
    const statusList = screen.getByRole('region', { name: 'Statuses' });
    expect(within(statusList).getByText('4 customers')).toBeInTheDocument();
  });

  it('adds a tier', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a tier' }));
    await user.type(screen.getByLabelText('New tier'), 'Growth');
    await user.click(screen.getByRole('button', { name: 'Add tier' }));
    await waitFor(() => {
      expect(createCustomerField).toHaveBeenCalledWith('tiers', {
        name: 'Growth',
        color: '#3b7cf0',
      });
    });
  });

  it('moves a tier up', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Enterprise' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    await waitFor(() => {
      expect(updateCustomerField).toHaveBeenCalledWith('tiers', 'tier-2', {
        position: 0,
      });
    });
  });

  it('asks for a replacement before deleting a held status', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Active' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete Active?',
    });
    const select = within(dialog).getByLabelText('Move customers to');
    expect(select).toHaveValue('lead');
    await user.selectOptions(select, 'churned');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteCustomerField).toHaveBeenCalledWith(
        'statuses',
        'active',
        'churned'
      );
    });
  });

  it('deletes an unheld tier without a replacement', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Actions for Enterprise' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete Enterprise?',
    });
    expect(
      within(dialog).queryByLabelText('Move customers to')
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteCustomerField).toHaveBeenCalledWith(
        'tiers',
        'tier-2',
        undefined
      );
    });
  });

  it('shows a member both lists with nothing to edit', async () => {
    useWorkspaceMock.mockReturnValue(resolved('member'));
    renderPage();
    expect(await screen.findByText('Enterprise')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Enterprise' })
    ).not.toBeInTheDocument();
  });
});
