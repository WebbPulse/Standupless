/**
 * The `O` then letter shortcuts: each opens the command palette straight onto
 * its picker, the picker lists what it names and opens the chosen row, and the
 * keys do nothing while someone is typing in a field.
 */

import { render, screen } from '@testing-library/react';
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
import type {
  CycleRead,
  FavoriteRead,
  ProjectRead,
  TeamRead,
  WorkspaceRead,
} from '../../types/Api';
import GlobalShortcuts from '../shortcuts/GlobalShortcuts';
import ShortcutProvider from '../shortcuts/ShortcutProvider';
import CommandPalette from './CommandPalette';

const navigate = vi.fn();
const listFavorites = vi.fn<() => Promise<FavoriteRead[]>>();
const listProjects = vi.fn<() => Promise<{ projects: ProjectRead[] }>>();
const listCycles = vi.fn<() => Promise<{ cycles: CycleRead[] }>>();

vi.mock('../../api/documents', () => ({
  listWorkspaceDocuments: () => Promise.resolve([]),
}));

vi.mock('../../api/views', () => ({
  search: () => Promise.resolve([]),
  listViews: () => Promise.resolve([]),
}));

vi.mock('../../api/templates', () => ({
  listTeamTemplates: () =>
    Promise.resolve({ templates: [], default_template_id: null }),
}));

vi.mock('../../api/favorites', () => ({
  listFavorites: () => listFavorites(),
}));

vi.mock('../../api/planning', () => ({
  listProjects: () => listProjects(),
  listCycles: () => listCycles(),
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

/** The one team the shell sees. */
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

/** The workspace the shell is in. */
const workspace = {
  id: 'ws-1',
  slug: 'mine',
  role: 'owner',
} as WorkspaceRead;

/** A cycle in the given state, starting on the given day. */
const cycle = (
  id: string,
  status: CycleRead['status'],
  start: string
): CycleRead =>
  ({
    cycle_id: id,
    team_id: 'team-1',
    name: `Cycle ${id}`,
    start_date: start,
    end_date: start,
    status,
  }) as CycleRead;

/** The palette state and global shortcuts wired the way the workspace shell does. */
const Shell: React.FC = () => {
  const palette = useCommandPalette();
  return (
    <CommandPaletteContext.Provider value={palette}>
      <input aria-label="Issue title" />
      <GlobalShortcuts
        workspace={workspace}
        teams={[engine]}
        onShowHelp={() => undefined}
      />
      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        workspace={workspace}
        teams={[engine]}
        picker={palette.picker}
      />
      <BoundKeys />
    </CommandPaletteContext.Provider>
  );
};

/** Renders the shell on the given route and waits for the open keys to bind. */
const renderShell = async (path = '/w/mine/team/ENG') => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <ShortcutProvider>
        <Shell />
      </ShortcutProvider>
    </MemoryRouter>
  );
  await keysBound('o f', 'o p', 'o c', 'o t', 'o v');
  return user;
};

beforeEach(() => {
  navigate.mockReset();
  listFavorites.mockReset();
  listFavorites.mockResolvedValue([]);
  listProjects.mockReset();
  listProjects.mockResolvedValue({ projects: [] });
  listCycles.mockReset();
  listCycles.mockResolvedValue({ cycles: [] });
});

describe('the open pickers', () => {
  it('opens the project picker on O then P and goes to the chosen project', async () => {
    listProjects.mockResolvedValue({
      projects: [
        {
          project_id: 'proj-1',
          name: 'Billing revamp',
          icon: null,
          color: null,
        } as ProjectRead,
      ],
    });
    const user = await renderShell();

    await user.keyboard('op');

    expect(
      await screen.findByRole('combobox', { name: 'Open a project' })
    ).toBeInTheDocument();
    await user.click(
      await screen.findByRole('option', { name: /Billing revamp/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/projects/proj-1');
  });

  it('opens the favorites picker on O then F', async () => {
    listFavorites.mockResolvedValue([
      {
        kind: 'issue',
        target_id: 'issue-1',
        title: 'Rotate the signing keys',
        issue_key: 'ENG-12',
      },
    ]);
    const user = await renderShell();

    await user.keyboard('of');

    await user.click(
      await screen.findByRole('option', { name: /Rotate the signing keys/ })
    );

    expect(navigate).toHaveBeenCalledWith('/w/mine/issues/ENG-12');
  });

  it('lists the current cycle first on O then C', async () => {
    listCycles.mockResolvedValue({
      cycles: [
        cycle('1', 'completed', '2026-09-01'),
        cycle('2', 'active', '2026-10-01'),
        cycle('3', 'upcoming', '2026-11-01'),
      ],
    });
    const user = await renderShell();

    await user.keyboard('oc');

    expect(
      await screen.findByRole('combobox', { name: 'Open a cycle' })
    ).toBeInTheDocument();
    const rows = await screen.findAllByRole('option');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Cycle 2'),
      expect.stringContaining('Cycle 3'),
      expect.stringContaining('Cycle 1'),
    ]);
  });

  it('opens the team picker on O then T', async () => {
    const user = await renderShell();

    await user.keyboard('ot');

    expect(
      await screen.findByRole('combobox', { name: 'Switch to a team' })
    ).toBeInTheDocument();
  });

  it('opens the view picker on O then V', async () => {
    const user = await renderShell();

    await user.keyboard('ov');

    expect(
      await screen.findByRole('combobox', { name: 'Open a saved view' })
    ).toBeInTheDocument();
  });

  it('stays shut while someone is typing in a field', async () => {
    const user = await renderShell();

    await user.click(screen.getByRole('textbox', { name: 'Issue title' }));
    await user.keyboard('op');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
