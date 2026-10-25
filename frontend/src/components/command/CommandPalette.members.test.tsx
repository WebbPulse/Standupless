/**
 * O then U opens the palette on a searchable member picker that shows names
 * and handles but never emails, and choosing a member opens their page. The
 * palette also lists Open member, Open my profile and Go to upcoming cycle
 * with their key hints.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommandPaletteContext,
  useCommandPalette,
} from '../../hooks/useCommandPalette';
import BoundKeys from '../../test/BoundKeys';
import { keysBound } from '../../test/shortcuts';
import type { MemberRead, TeamRead, WorkspaceRead } from '../../types/Api';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutHelp from '../shortcuts/ShortcutHelp';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();

/** The workspace's members, one of them the viewer. */
const MEMBERS: MemberRead[] = [
  {
    user_id: 'user-2',
    email: 'zoe@example.test',
    display_name: 'zoe',
    full_name: 'Zoe Park',
    role: 'member',
    joined_at: '2026-09-17T00:00:00Z',
  },
  {
    user_id: 'user-1',
    email: 'ada@example.test',
    display_name: 'ada',
    full_name: 'Ada Lovelace',
    role: 'owner',
    joined_at: '2026-09-17T00:00:00Z',
  },
];

vi.mock('../../api/workspaces', async () => {
  const actual = await vi.importActual<typeof import('../../api/workspaces')>(
    '../../api/workspaces'
  );
  return { ...actual, listMembers: () => Promise.resolve(MEMBERS) };
});

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
  listViews: () => Promise.resolve([]),
}));

vi.mock('../../api/favorites', () => ({
  listFavorites: () => Promise.resolve([]),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => Promise.resolve({ projects: [] }),
  listCycles: () => Promise.resolve({ cycles: [], next_cursor: null }),
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

const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** The palette and global shortcuts wired the way the workspace shell does. */
const Shell: React.FC<{ help?: boolean }> = ({ help = false }) => {
  const palette = useCommandPalette();
  return (
    <CommandPaletteContext.Provider value={palette}>
      <GlobalShortcuts
        workspace={workspace}
        teams={[engine]}
        currentUserId="user-1"
        onShowHelp={() => undefined}
      />
      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        workspace={workspace}
        teams={[engine]}
        picker={palette.picker}
        currentUserId="user-1"
      />
      {help && <ShortcutHelp open onClose={() => undefined} />}
      <BoundKeys />
    </CommandPaletteContext.Provider>
  );
};

/** Renders the shell and waits for the new keys to bind. */
const renderShell = async (help = false) => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG']}>
      <ShortcutProvider>
        <Shell help={help} />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('o u', 'o m', 'g w');
  return user;
};

beforeEach(() => {
  navigate.mockReset();
});

describe('O then U', () => {
  it('opens the member picker sorted by name without emails', async () => {
    const user = await renderShell();

    await user.keyboard('ou');

    expect(
      await screen.findByRole('combobox', { name: 'Open a member' })
    ).toBeInTheDocument();
    const rows = await screen.findAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('ada'),
      expect.stringContaining('zoe'),
    ]);
    expect(screen.queryByText(/example\.test/)).toBeNull();
  });

  it("filters by written name and opens the chosen member's page", async () => {
    const user = await renderShell();

    await user.keyboard('ou');
    const input = await screen.findByRole('combobox', {
      name: 'Open a member',
    });
    await screen.findAllByRole('option');
    await user.type(input, 'park');

    const rows = await screen.findAllByRole('option');
    expect(rows).toHaveLength(1);
    await user.click(rows[0]!);

    expect(navigate).toHaveBeenCalledWith('/w/mine/members/user-2');
  });

  it('lists O then U and O then M under Open in the shortcut sheet', async () => {
    await renderShell(true);

    const open = screen.getByRole('region', { name: 'Open' });
    expect(within(open).getByText('Open member')).toBeInTheDocument();
    expect(within(open).getByText('Open my profile')).toBeInTheDocument();
  });
});

describe('palette commands', () => {
  it.each([
    ['open member', 'Open member', 'O then U'],
    ['my profile', 'Open my profile', 'O then M'],
    ['upcoming cycle', 'Go to upcoming cycle', 'G then W'],
  ])('lists %s with its key hint', async (term, label, hint) => {
    const user = await renderShell();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), term);

    const row = await screen.findByRole('option', {
      name: new RegExp(label),
    });
    expect(row.textContent).toContain(hint);
  });

  it('opens my profile from its row', async () => {
    const user = await renderShell();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'my profile');

    await user.click(
      await screen.findByRole('option', { name: /Open my profile/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/members/user-1');
  });
});
