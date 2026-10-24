/**
 * The G then V shortcut: inside a team it opens that team's views and the
 * help lists it as team views, and anywhere else it opens the workspace
 * Views page. G then A opens the current cycle of the team in context and
 * the help lists it.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { TeamRead, WorkspaceRead } from '../../types/Api';
import GlobalShortcuts from './GlobalShortcuts';
import ShortcutHelp from './ShortcutHelp';
import ShortcutProvider from './ShortcutProvider';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => navigate };
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

/** The teams the shell sees, the first of which is not the routed one. */
const teams = [
  team('team-1', 'Engine', 'ENG'),
  team('team-2', 'Design', 'DES'),
];

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** Renders the global shortcuts on a route, with the help when asked. */
const renderShortcuts = async (path: string, help = false) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <GlobalShortcuts
          workspace={workspace}
          teams={teams}
          onShowHelp={() => undefined}
        />
        {help && <ShortcutHelp open onClose={() => undefined} />}
        <BoundKeys />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('g v');
  return user;
};

beforeEach(() => {
  navigate.mockReset();
});

describe('G then V', () => {
  it("opens the routed team's views from inside a team", async () => {
    const user = await renderShortcuts('/w/mine/team/DES/board');

    await user.keyboard('gv');

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/views');
  });

  it("opens the issue's team views from an issue page", async () => {
    const user = await renderShortcuts('/w/mine/issues/DES-12');

    await user.keyboard('gv');

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/views');
  });

  it('opens the workspace views page outside a team', async () => {
    const user = await renderShortcuts('/w/mine/inbox');

    await user.keyboard('gv');

    expect(navigate).toHaveBeenCalledWith('/w/mine/views');
  });

  it('lists the shortcut as team views inside a team', async () => {
    await renderShortcuts('/w/mine/team/ENG', true);

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(
      within(navigation).getByText('Go to team views')
    ).toBeInTheDocument();
    expect(within(navigation).queryByText('Go to views')).toBeNull();
  });

  it('lists the shortcut as views outside a team', async () => {
    await renderShortcuts('/w/mine/inbox', true);

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(within(navigation).getByText('Go to views')).toBeInTheDocument();
    expect(within(navigation).queryByText('Go to team views')).toBeNull();
  });
});

describe('G then A', () => {
  it("opens the routed team's current cycle", async () => {
    const user = await renderShortcuts('/w/mine/team/DES/board');

    await user.keyboard('ga');

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/cycles/current');
  });

  it("opens the issue's team current cycle from an issue page", async () => {
    const user = await renderShortcuts('/w/mine/issues/DES-12');

    await user.keyboard('ga');

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/DES/cycles/current');
  });

  it('opens the first team current cycle outside a team', async () => {
    const user = await renderShortcuts('/w/mine/inbox');

    await user.keyboard('ga');

    expect(navigate).toHaveBeenCalledWith('/w/mine/team/ENG/cycles/current');
  });

  it('lists the shortcut in the shortcut sheet', async () => {
    await renderShortcuts('/w/mine/team/ENG', true);

    const navigation = screen.getByRole('region', { name: 'Navigation' });
    expect(
      within(navigation).getByText('Go to current cycle')
    ).toBeInTheDocument();
  });
});
