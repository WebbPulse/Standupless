/**
 * Initiatives and customers in the command palette: a typed term lists them
 * by name under their own headings, Open initiative and Open customer open
 * pickers of every one the viewer's reads return, choosing a row opens its
 * page, and a guest is offered neither.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CustomerRead,
  InitiativeRead,
  TeamRead,
  WorkspaceRead,
  WorkspaceRole,
} from '../../types/Api';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();
const listInitiatives =
  vi.fn<() => Promise<{ initiatives: InitiativeRead[] }>>();
const listCustomers = vi.fn<() => Promise<CustomerRead[]>>();

vi.mock('../../hooks/useWorkspaceMembers', () => ({
  useWorkspaceMembers: () => [],
}));

vi.mock('../../api/initiatives', () => ({
  listInitiatives: async () => ({
    ...(await listInitiatives()),
    next_cursor: null,
  }),
}));

vi.mock('../../api/customers', () => ({
  listCustomers: () => listCustomers(),
}));

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
  listViews: () => Promise.resolve([]),
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
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

const engine: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
};

/** An initiative with the given id and name. */
const initiative = (id: string, name: string): InitiativeRead =>
  ({
    initiative_id: id,
    workspace_id: 'ws-1',
    name,
    status: 'active',
  }) as InitiativeRead;

/** A customer with the given id, name and domains. */
const customer = (
  id: string,
  name: string,
  domains: string[] = []
): CustomerRead =>
  ({
    customer_id: id,
    workspace_id: 'ws-1',
    name,
    domains,
    tier: null,
  }) as unknown as CustomerRead;

/** Renders the open palette for a viewer with the given workspace role. */
const renderPalette = (role: WorkspaceRole = 'owner') => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
      <ShortcutProvider>
        <CommandPalette
          open
          onClose={() => undefined}
          workspace={{ id: 'ws-1', slug: 'mine', role } as WorkspaceRead}
          teams={[engine]}
        />
      </ShortcutProvider>
    </MemoryRouter>
  );
  return user;
};

beforeEach(() => {
  navigate.mockReset();
  listInitiatives.mockReset();
  listInitiatives.mockResolvedValue({
    initiatives: [
      initiative('ini-1', 'Enterprise readiness'),
      initiative('ini-2', 'Mobile launch'),
    ],
  });
  listCustomers.mockReset();
  listCustomers.mockResolvedValue([
    customer('cus-1', 'Acme Corp', ['acme.test']),
    customer('cus-2', 'Globex'),
  ]);
});

describe('a typed term', () => {
  it('lists a matching initiative and opens it', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'enterprise');

    const group = await screen.findByRole('group', { name: 'Initiatives' });
    const row = within(group).getByRole('option', {
      name: /Enterprise readiness/,
    });
    expect(within(group).queryByText('Mobile launch')).toBeNull();
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/initiatives/ini-1');
  });

  it('lists a matching customer, by name or domain, and opens it', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'acme.test');

    const group = await screen.findByRole('group', { name: 'Customers' });
    await user.click(within(group).getByRole('option', { name: /Acme Corp/ }));

    expect(navigate).toHaveBeenCalledWith('/w/mine/customers/cus-1');
  });

  it('lists neither for a guest', async () => {
    const user = renderPalette('guest');
    await user.type(screen.getByRole('combobox'), 'theme');

    await screen.findAllByRole('option');
    expect(screen.queryByRole('group', { name: 'Customers' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Initiatives' })).toBeNull();
    expect(listCustomers).not.toHaveBeenCalled();
    expect(listInitiatives).not.toHaveBeenCalled();
  });
});

describe('the pickers', () => {
  it('opens every initiative from Open initiative', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'open initiative');
    await user.click(
      await screen.findByRole('option', { name: /Open initiative/ })
    );

    expect(
      await screen.findByRole('combobox', { name: 'Open an initiative' })
    ).toBeInTheDocument();
    await screen.findByRole('option', { name: /Mobile launch/ });
    const rows = screen.getAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Enterprise readiness'),
      expect.stringContaining('Mobile launch'),
    ]);
    await user.click(rows[1]!);

    expect(navigate).toHaveBeenCalledWith('/w/mine/initiatives/ini-2');
  });

  it('opens every customer from Open customer', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'open customer');
    await user.click(
      await screen.findByRole('option', { name: /Open customer/ })
    );

    const input = await screen.findByRole('combobox', {
      name: 'Open a customer',
    });
    await screen.findByRole('option', { name: /Globex/ });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.type(input, 'glob');
    const rows = await screen.findAllByRole('option');
    expect(rows).toHaveLength(1);
    await user.click(rows[0]!);

    expect(navigate).toHaveBeenCalledWith('/w/mine/customers/cus-2');
  });

  it('offers neither picker to a guest', async () => {
    const user = renderPalette('guest');
    await user.type(screen.getByRole('combobox'), 'open');

    await screen.findAllByRole('option');
    expect(
      screen.queryByRole('option', { name: /Open initiative/ })
    ).toBeNull();
    expect(screen.queryByRole('option', { name: /Open customer/ })).toBeNull();
  });
});
