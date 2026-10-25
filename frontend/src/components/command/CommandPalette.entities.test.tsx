/**
 * Projects, cycles, saved views, initiatives and customers in the command
 * palette: a typed term lists them by name under their own headings, up to
 * eight a group, Open initiative and Open customer open pickers of every one
 * the viewer's reads return, choosing a row opens its page, and a guest is
 * offered no initiatives or customers but still finds what their reads return.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cyclePath } from '../../lib/paths';
import type {
  CustomerRead,
  CycleRead,
  InitiativeRead,
  ProjectRead,
  SavedViewDisplayRead,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();
const listInitiatives =
  vi.fn<() => Promise<{ initiatives: InitiativeRead[] }>>();
const listCustomers = vi.fn<() => Promise<CustomerRead[]>>();
const listProjects = vi.fn<() => Promise<{ projects: ProjectRead[] }>>();
const listCycles = vi.fn<() => Promise<{ cycles: CycleRead[] }>>();
const listViews = vi.fn<() => Promise<SavedViewDisplayRead[]>>();

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
  listViews: () => listViews(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: async () => ({
    ...(await listProjects()),
    next_cursor: null,
  }),
  listCycles: async () => ({ ...(await listCycles()), next_cursor: null }),
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

/** A project with the given id and name. */
const project = (id: string, name: string): ProjectRead =>
  ({
    project_id: id,
    name,
    icon: null,
    color: null,
  }) as ProjectRead;

/** One of the Engine team's cycles, with the given id, name and status. */
const cycle = (
  id: string,
  name: string,
  status: CycleRead['status'] = 'active'
): CycleRead =>
  ({
    cycle_id: id,
    team_id: 'team-1',
    name,
    start_date: '2026-10-01',
    end_date: '2026-10-14',
    status,
  }) as CycleRead;

/** A saved view with the given id and name. */
const view = (id: string, name: string): SavedViewDisplayRead =>
  ({
    view_id: id,
    name,
    layout: 'list',
  }) as SavedViewDisplayRead;

/** Renders the open palette for a viewer with the given workspace role. */
const renderPalette = (role: WorkspaceRole = 'owner') => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
      <ShortcutProvider>
        <CommandPalette
          open
          onClose={() => undefined}
          workspace={{ id: 'ws-1', slug: 'mine', role }}
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
  listProjects.mockReset();
  listProjects.mockResolvedValue({
    projects: [
      project('proj-1', 'Billing revamp'),
      project('proj-2', 'Search rewrite'),
    ],
  });
  listCycles.mockReset();
  listCycles.mockResolvedValue({
    cycles: [cycle('cyc-1', 'Autumn hardening'), cycle('cyc-2', 'Cycle 9')],
  });
  listViews.mockReset();
  listViews.mockResolvedValue([
    view('view-1', 'Hot bugs'),
    view('view-2', 'Release board'),
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

  it('lists a matching project and opens it', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'billing');

    const group = await screen.findByRole('group', { name: 'Projects' });
    const row = within(group).getByRole('option', { name: /Billing revamp/ });
    expect(within(group).queryByText('Search rewrite')).toBeNull();
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/projects/proj-1');
  });

  it('lists a matching cycle of the team in view and opens it', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'autumn');

    const group = await screen.findByRole('group', { name: 'Cycles' });
    const row = within(group).getByRole('option', {
      name: /Autumn hardening/,
    });
    expect(within(group).queryByText('Cycle 9')).toBeNull();
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith(cyclePath('mine', 'ENG', 'cyc-1'));
  });

  it('lists a matching saved view and opens it', async () => {
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'release board');

    const group = await screen.findByRole('group', { name: 'Views' });
    const row = within(group).getByRole('option', { name: /Release board/ });
    expect(within(group).queryByText('Hot bugs')).toBeNull();
    await user.click(row);

    expect(navigate).toHaveBeenCalledWith('/w/mine/views/view-2');
  });

  it('lists at most eight projects, cycles and views a group', async () => {
    const many = Array.from({ length: 12 }, (_, index) => index + 1);
    listProjects.mockResolvedValue({
      projects: many.map((n) => project(`proj-${n}`, `Zephyr project ${n}`)),
    });
    listCycles.mockResolvedValue({
      cycles: many.map((n) => cycle(`cyc-${n}`, `Zephyr cycle ${n}`)),
    });
    listViews.mockResolvedValue(
      many.map((n) => view(`view-${n}`, `Zephyr view ${n}`))
    );
    const user = renderPalette();
    await user.type(screen.getByRole('combobox'), 'zephyr');

    for (const name of ['Projects', 'Cycles', 'Views']) {
      const group = await screen.findByRole('group', { name });
      expect(within(group).getAllByRole('option')).toHaveLength(8);
    }
  });

  it('lists projects, cycles and views for a guest', async () => {
    const user = renderPalette('guest');
    await user.type(screen.getByRole('combobox'), 'billing');

    const group = await screen.findByRole('group', { name: 'Projects' });
    expect(
      within(group).getByRole('option', { name: /Billing revamp/ })
    ).toBeInTheDocument();
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
