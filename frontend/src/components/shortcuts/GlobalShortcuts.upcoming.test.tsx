/**
 * G then W opens the next upcoming cycle of the team in context, or of the
 * first team outside one, and a team with none shows a toast and stays put.
 * O then M opens the viewer's own member page. The help lists both.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type {
  CycleListQuery,
  CycleRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import GlobalShortcuts from './GlobalShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

const navigate = vi.fn();
const showToast = vi.fn();
const listCycles =
  vi.fn<
    (
      workspaceId: string,
      query: CycleListQuery
    ) => Promise<{ cycles: CycleRead[]; next_cursor: string | null }>
  >();

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('../../api/planning', () => ({
  listCycles: (workspaceId: string, query: CycleListQuery) =>
    listCycles(workspaceId, query),
}));

vi.mock('../../lib/toast', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/toast')>('../../lib/toast');
  return {
    ...actual,
    showToast: (message: string) => showToast(message),
  };
});

/** A team the workspace holds. */
const team = (id: string, name: string, keyPrefix: string): TeamRead => ({
  id,
  workspace_id: 'ws-1',
  name,
  key_prefix: keyPrefix,
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  role: 'admin',
});

const teams = [
  team('team-1', 'Engine', 'ENG'),
  team('team-2', 'Design', 'DES'),
];

const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** A cycle of a team in the given state. */
const cycle = (
  id: string,
  teamId: string,
  status: CycleRead['status']
): CycleRead =>
  ({
    cycle_id: id,
    team_id: teamId,
    name: `Cycle ${id}`,
    start_date: '2026-11-01',
    end_date: '2026-11-14',
    status,
  }) as CycleRead;

/** Renders the global shortcuts on a route, with the help when asked. */
const renderShortcuts = async (
  path: string,
  { help = false, currentUserId = 'user-1' as string | undefined } = {}
) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <GlobalShortcuts
          workspace={workspace}
          teams={teams}
          currentUserId={currentUserId}
          onShowHelp={() => undefined}
        />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('g w');
  return user;
};

beforeEach(() => {
  navigate.mockReset();
  showToast.mockReset();
  listCycles.mockReset();
});

describe('G then W', () => {
  it("opens the routed team's next upcoming cycle", async () => {
    listCycles.mockResolvedValue({
      cycles: [cycle('c-7', 'team-2', 'upcoming')],
      next_cursor: null,
    });
    const user = await renderShortcuts('/w/mine/team/DES/board');

    await user.keyboard('gw');

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/cycles/c-7');
    });
    expect(listCycles).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ team_id: 'team-2', status: 'upcoming' })
    );
  });

  it('uses the first team outside a team', async () => {
    listCycles.mockResolvedValue({
      cycles: [cycle('c-3', 'team-1', 'upcoming')],
      next_cursor: null,
    });
    const user = await renderShortcuts('/w/mine/inbox');

    await user.keyboard('gw');

    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/w/mine/team/ENG/cycles/c-3');
    });
  });

  it('shows a toast and stays put when no cycle is upcoming', async () => {
    listCycles.mockResolvedValue({ cycles: [], next_cursor: null });
    const user = await renderShortcuts('/w/mine/team/DES/board');

    await user.keyboard('gw');

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Design has no upcoming cycle.');
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lists the shortcut under Navigation', async () => {
    await renderShortcuts('/w/mine/team/ENG', { help: true });

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(
      within(navigation).getByText('Go to upcoming cycle')
    ).toBeInTheDocument();
  });
});

describe('O then M', () => {
  it("opens the viewer's own member page", async () => {
    const user = await renderShortcuts('/w/mine/inbox');
    await keysBound('o m');

    await user.keyboard('om');

    expect(navigate).toHaveBeenCalledWith('/w/mine/members/user-1');
  });

  it('lists the shortcut under Open', async () => {
    await renderShortcuts('/w/mine/inbox', { help: true });

    const open = screen.getByRole('region', { name: 'Open' });
    expect(within(open).getByText('Open my profile')).toBeInTheDocument();
  });
});
