/**
 * Starring from the rest of the sidebar: a team's header or page dropped on a
 * favorites folder or the Favorites heading stars the team there, or moves it
 * when it is already starred; the team menu does the same from the keyboard;
 * and a folder's menu copies its favorites' links.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FavoriteFolderRead,
  FavoriteRead,
  FavoriteRef,
  TeamRead,
} from '../../types/Api';
import Menu from '../ui/menu';
import AddToFavoriteFolder from './AddToFavoriteFolder';
import FavoritesSection from './FavoritesSection';

const listFavorites = vi.fn<() => Promise<FavoriteRead[]>>();
const listFavoriteFolders = vi.fn<() => Promise<FavoriteFolderRead[]>>();
const addFavorite = vi.fn<(ref: FavoriteRef) => Promise<FavoriteRead>>();
const showToast = vi.fn<(message: string) => number>();

vi.mock('../../api/favorites', () => ({
  listFavorites: () => listFavorites(),
  listFavoriteFolders: () => listFavoriteFolders(),
  addFavorite: (_w: string, ref: FavoriteRef) => addFavorite(ref),
  removeFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
  createFavoriteFolder: vi.fn(),
  renameFavoriteFolder: vi.fn(),
  deleteFavoriteFolder: vi.fn(),
}));

vi.mock('../../lib/toast', () => ({
  showToast: (message: string) => showToast(message),
  showErrorToast: vi.fn(),
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

const launch: FavoriteFolderRead = {
  folder_id: 'f-1',
  name: 'Launch',
  position: 0,
};

const billing: FavoriteRead = {
  kind: 'project',
  target_id: 'project-1',
  title: 'Billing',
  folder_id: 'f-1',
};
const bugs: FavoriteRead = {
  kind: 'view',
  target_id: 'view-1',
  title: 'My bugs',
  folder_id: 'f-1',
};

let workspaceCount = 0;

/** Renders Favorites beside a team section inside one sidebar nav, for a fresh workspace. */
const renderSidebar = (): void => {
  workspaceCount += 1;
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <div data-testid="sidebar-nav">
        <FavoritesSection
          workspaceId={`ws-drag-${String(workspaceCount)}`}
          slug="mine"
          teams={[engine]}
          rowClass={() => 'row'}
          heading={<h2 id="sidebar-favorites">Favorites</h2>}
        />
        <div data-testid="team-section-team-1">
          <a href="/w/mine/team/ENG/cycles">Cycles</a>
        </div>
      </div>
    </MemoryRouter>
  );
};

/** Starts dragging an element and waits for the sidebar to notice. */
const startDrag = async (element: Element): Promise<void> => {
  fireEvent.dragStart(element);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  globalThis.localStorage.clear();
  listFavorites.mockReset();
  listFavorites.mockResolvedValue([billing, bugs]);
  listFavoriteFolders.mockReset();
  listFavoriteFolders.mockResolvedValue([launch]);
  addFavorite.mockReset();
  addFavorite.mockImplementation((ref) => {
    const added: FavoriteRead = {
      kind: ref.kind,
      target_id: ref.target_id,
      title: 'Engine',
      team_key_prefix: 'ENG',
      folder_id: ref.folder_id ?? null,
    };
    listFavorites.mockResolvedValue([billing, bugs, added]);
    return Promise.resolve(added);
  });
  showToast.mockReset();
});

describe('dragging sidebar rows into Favorites', () => {
  it('stars a team page dropped on a folder in that folder', async () => {
    renderSidebar();
    const folder = await screen.findByTestId('favorite-folder-f-1');

    await startDrag(screen.getByRole('link', { name: 'Cycles' }));
    fireEvent.dragEnter(folder);
    fireEvent.dragOver(folder);
    expect(within(folder).getByRole('button', { name: /Launch/ })).toHaveClass(
      'ring-accent'
    );
    fireEvent.drop(folder);

    expect(addFavorite).toHaveBeenCalledWith({
      kind: 'team',
      target_id: 'team-1',
      folder_id: 'f-1',
    });
    expect(
      await within(screen.getByTestId('favorite-folder-panel-f-1')).findByRole(
        'link',
        { name: /Engine/ }
      )
    ).toHaveAttribute('href', '/w/mine/team/ENG');
  });

  it('stars a team dropped on the Favorites heading at the top level', async () => {
    renderSidebar();
    await screen.findByTestId('favorite-folder-f-1');
    const heading = screen.getByTestId('favorites-heading');

    await startDrag(screen.getByTestId('team-section-team-1'));
    fireEvent.dragEnter(heading);
    expect(heading).toHaveClass('ring-accent');
    fireEvent.dragOver(heading);
    fireEvent.drop(heading);

    expect(addFavorite).toHaveBeenCalledWith({
      kind: 'team',
      target_id: 'team-1',
      folder_id: null,
    });
  });

  it('shows the heading to drop on while nothing is starred', async () => {
    listFavorites.mockResolvedValue([]);
    listFavoriteFolders.mockResolvedValue([]);
    renderSidebar();

    expect(screen.queryByTestId('favorites-heading')).not.toBeInTheDocument();
    await startDrag(screen.getByRole('link', { name: 'Cycles' }));

    expect(screen.getByTestId('favorites-heading')).toBeInTheDocument();
    fireEvent.dragEnd(screen.getByRole('link', { name: 'Cycles' }));
    await waitFor(() => {
      expect(screen.queryByTestId('favorites-heading')).not.toBeInTheDocument();
    });
  });

  it('ignores a drag that starts outside the team sections', async () => {
    renderSidebar();
    const folder = await screen.findByTestId('favorite-folder-f-1');

    await startDrag(screen.getByRole('heading', { name: 'Favorites' }));
    fireEvent.drop(folder);

    expect(addFavorite).not.toHaveBeenCalled();
  });
});

describe('copying a folder links', () => {
  it('copies one absolute link per line in folder order and says how many', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    renderSidebar();

    const folder = await screen.findByTestId('favorite-folder-f-1');
    await user.click(
      within(folder).getByRole('button', { name: 'Folder options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Copy links' }));

    const origin = globalThis.location.origin;
    expect(writeText).toHaveBeenCalledWith(
      `${origin}/w/mine/projects/project-1\n${origin}/w/mine/views/view-1`
    );
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Copied 2 links');
    });
  });
});

describe('adding to a favorites folder from a menu', () => {
  it('lists the folders and stars the target in the one picked', async () => {
    const user = userEvent.setup();
    workspaceCount += 1;
    render(
      <MemoryRouter>
        <Menu
          label="Engine actions"
          trigger={(props) => (
            <button type="button" {...props}>
              Team options
            </button>
          )}
        >
          <AddToFavoriteFolder
            workspaceId={`ws-drag-${String(workspaceCount)}`}
            target={{ kind: 'team', target_id: 'team-1' }}
            title="Engine"
            preview={{ team_key_prefix: 'ENG' }}
          />
        </Menu>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(listFavoriteFolders).toHaveBeenCalled();
    });
    await user.click(screen.getByRole('button', { name: 'Team options' }));
    expect(
      await screen.findByText('Add to favorites folder')
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: /Launch/ }));

    expect(addFavorite).toHaveBeenCalledWith({
      kind: 'team',
      target_id: 'team-1',
      folder_id: 'f-1',
    });
    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith('Added to Launch');
    });
  });
});
