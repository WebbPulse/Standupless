/**
 * Favorite folders in the sidebar: folders draw above the top-level favorites
 * with what they hold, collapse and remember it, rename in place, take a
 * favorite through its menu or a drop, and hand their favorites back to the
 * top level when deleted.
 */

import {
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
  FavoriteOrder,
  FavoriteRead,
} from '../../types/Api';
import { collapsedFoldersKey } from './FavoriteFolders';
import FavoritesSection from './FavoritesSection';

const listFavorites = vi.fn<() => Promise<FavoriteRead[]>>();
const listFavoriteFolders = vi.fn<() => Promise<FavoriteFolderRead[]>>();
const reorderFavorites =
  vi.fn<(order: FavoriteOrder) => Promise<FavoriteRead[]>>();
const createFavoriteFolder =
  vi.fn<(name: string) => Promise<FavoriteFolderRead>>();
const renameFavoriteFolder =
  vi.fn<(folderId: string, name: string) => Promise<FavoriteFolderRead>>();
const deleteFavoriteFolder = vi.fn<(folderId: string) => Promise<void>>();

vi.mock('../../api/favorites', () => ({
  listFavorites: () => listFavorites(),
  listFavoriteFolders: () => listFavoriteFolders(),
  addFavorite: vi.fn(),
  removeFavorite: vi.fn(),
  reorderFavorites: (_w: string, order: FavoriteOrder) =>
    reorderFavorites(order),
  createFavoriteFolder: (_w: string, name: string) =>
    createFavoriteFolder(name),
  renameFavoriteFolder: (_w: string, folderId: string, name: string) =>
    renameFavoriteFolder(folderId, name),
  deleteFavoriteFolder: (_w: string, folderId: string) =>
    deleteFavoriteFolder(folderId),
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

const launch: FavoriteFolderRead = {
  folder_id: 'f-1',
  name: 'Launch',
  position: 0,
};
const later: FavoriteFolderRead = {
  folder_id: 'f-2',
  name: 'Later',
  position: 1,
};

const inLaunch: FavoriteRead = {
  kind: 'view',
  target_id: 'view-1',
  title: 'My bugs',
  folder_id: 'f-1',
};
const loose: FavoriteRead = {
  kind: 'project',
  target_id: 'project-1',
  title: 'Billing',
  folder_id: null,
};

let workspaceCount = 0;

/** Renders the section for a fresh workspace, so no read is shared between tests. */
const renderSection = (): string => {
  workspaceCount += 1;
  const workspaceId = `ws-folders-${String(workspaceCount)}`;
  render(
    <MemoryRouter initialEntries={['/w/mine']}>
      <FavoritesSection
        workspaceId={workspaceId}
        slug="mine"
        teams={[]}
        rowClass={() => 'row'}
        heading={<h2 id="sidebar-favorites">Favorites</h2>}
      />
    </MemoryRouter>
  );
  return workspaceId;
};

beforeEach(() => {
  globalThis.localStorage.clear();
  listFavorites.mockReset();
  listFavorites.mockResolvedValue([inLaunch, loose]);
  listFavoriteFolders.mockReset();
  listFavoriteFolders.mockResolvedValue([launch, later]);
  reorderFavorites.mockReset();
  reorderFavorites.mockImplementation((order) => {
    const moved = order.items.flatMap((item) => {
      const row = [inLaunch, loose].find(
        (favorite) => favorite.target_id === item.target_id
      );
      return row === undefined
        ? []
        : [{ ...row, folder_id: item.folder_id ?? null }];
    });
    if (moved.length > 0) listFavorites.mockResolvedValue(moved);
    return Promise.resolve(moved);
  });
  createFavoriteFolder.mockReset();
  renameFavoriteFolder.mockReset();
  renameFavoriteFolder.mockImplementation((folderId, name) => {
    const renamed = { ...launch, folder_id: folderId, name };
    listFavoriteFolders.mockResolvedValue([renamed, later]);
    return Promise.resolve(renamed);
  });
  deleteFavoriteFolder.mockReset();
  deleteFavoriteFolder.mockImplementation(() => {
    listFavoriteFolders.mockResolvedValue([later]);
    listFavorites.mockResolvedValue([{ ...inLaunch, folder_id: null }, loose]);
    return Promise.resolve();
  });
});

describe('favorite folders', () => {
  it('draws folders above the top level with the favorites each holds', async () => {
    renderSection();

    const folder = await screen.findByTestId('favorite-folder-panel-f-1');
    expect(
      within(folder).getByRole('link', { name: /My bugs/ })
    ).toHaveAttribute('href', '/w/mine/views/view-1');
    expect(
      within(screen.getByTestId('favorite-folder-panel-f-2')).getByText(
        'No favorites'
      )
    ).toBeInTheDocument();
    const section = screen.getByTestId('sidebar-favorites');
    const links = within(section).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/w/mine/views/view-1',
      '/w/mine/projects/project-1',
    ]);
  });

  it('shows the section for a folder even while nothing is starred', async () => {
    listFavorites.mockResolvedValue([]);
    renderSection();

    expect(
      await screen.findByRole('button', { name: /Launch/ })
    ).toBeInTheDocument();
  });

  it('collapses a folder and remembers it for the next visit', async () => {
    const user = userEvent.setup();
    const workspaceId = renderSection();

    const toggle = await screen.findByRole('button', { name: /Launch/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('link', { name: /My bugs/ })
    ).not.toBeInTheDocument();
    expect(
      JSON.parse(
        globalThis.localStorage.getItem(collapsedFoldersKey(workspaceId)) ??
          '[]'
      )
    ).toEqual(['f-1']);
  });

  it('makes a folder from the heading menu and opens its name for editing', async () => {
    const user = userEvent.setup();
    const created: FavoriteFolderRead = {
      folder_id: 'f-3',
      name: 'New folder',
      position: 2,
    };
    createFavoriteFolder.mockImplementation(() => {
      listFavoriteFolders.mockResolvedValue([launch, later, created]);
      return Promise.resolve(created);
    });
    renameFavoriteFolder.mockImplementation((_id, name) => {
      const renamed = { ...created, name };
      listFavoriteFolders.mockResolvedValue([launch, later, renamed]);
      return Promise.resolve(renamed);
    });
    renderSection();

    await user.click(
      await screen.findByRole('button', { name: 'Favorites options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'New folder' }));

    const input = await screen.findByRole('textbox', { name: 'Folder name' });
    expect(createFavoriteFolder).toHaveBeenCalledWith('New folder');
    await user.clear(input);
    await user.type(input, 'Q4{Enter}');

    expect(renameFavoriteFolder).toHaveBeenCalledWith('f-3', 'Q4');
    expect(
      await screen.findByRole('button', { name: /Q4/ })
    ).toBeInTheDocument();
  });

  it('renames a folder in place and leaves it alone on Escape', async () => {
    const user = userEvent.setup();
    renderSection();

    const toggle = await screen.findByRole('button', { name: /Launch/ });
    fireEvent.doubleClick(toggle);
    const input = screen.getByRole('textbox', { name: 'Folder name' });
    await user.clear(input);
    await user.type(input, 'Nope{Escape}');
    expect(renameFavoriteFolder).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByRole('button', { name: /Launch/ }));
    const again = screen.getByRole('textbox', { name: 'Folder name' });
    await user.clear(again);
    await user.type(again, 'Shipped{Enter}');

    expect(renameFavoriteFolder).toHaveBeenCalledWith('f-1', 'Shipped');
    expect(
      await screen.findByRole('button', { name: /Shipped/ })
    ).toBeInTheDocument();
  });

  it('moves a favorite into a folder from its menu', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = await screen.findByTestId('favorite-project-project-1');
    await user.click(
      within(row).getByRole('button', { name: 'Favorite options' })
    );
    await user.click(screen.getByRole('menuitem', { name: /Later/ }));

    expect(reorderFavorites).toHaveBeenCalledWith({
      items: [
        {
          kind: 'view',
          target_id: 'view-1',
          team_id: null,
          folder_id: 'f-1',
        },
        {
          kind: 'project',
          target_id: 'project-1',
          team_id: null,
          folder_id: 'f-2',
        },
      ],
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId('favorite-folder-panel-f-2')).getByRole(
          'link',
          { name: /Billing/ }
        )
      ).toBeInTheDocument();
    });
  });

  it('moves a favorite out of its folder from its menu', async () => {
    const user = userEvent.setup();
    renderSection();

    const row = await screen.findByTestId('favorite-view-view-1');
    await user.click(
      within(row).getByRole('button', { name: 'Favorite options' })
    );
    await user.click(
      screen.getByRole('menuitem', { name: 'Move out of folder' })
    );

    const sent = reorderFavorites.mock.calls[0]?.[0];
    expect(sent?.items.map((item) => [item.target_id, item.folder_id])).toEqual(
      [
        ['project-1', null],
        ['view-1', null],
      ]
    );
  });

  it('moves a favorite dropped onto a folder into it', async () => {
    renderSection();

    const row = await screen.findByTestId('favorite-project-project-1');
    const folder = screen.getByTestId('favorite-folder-f-1');
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'none' };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragEnter(folder, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });

    const sent = reorderFavorites.mock.calls[0]?.[0];
    expect(sent?.items.map((item) => [item.target_id, item.folder_id])).toEqual(
      [
        ['view-1', 'f-1'],
        ['project-1', 'f-1'],
      ]
    );
  });

  it('reorders folders from the folder menu', async () => {
    const user = userEvent.setup();
    renderSection();

    const folder = await screen.findByTestId('favorite-folder-f-2');
    await user.click(
      within(folder).getByRole('button', { name: 'Folder options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));

    expect(reorderFavorites).toHaveBeenCalledWith({
      items: [],
      folders: ['f-2', 'f-1'],
    });
  });

  it('hands a deleted folder favorites back to the top level', async () => {
    const user = userEvent.setup();
    renderSection();

    const folder = await screen.findByTestId('favorite-folder-f-1');
    await user.click(
      within(folder).getByRole('button', { name: 'Folder options' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder' }));

    expect(deleteFavoriteFolder).toHaveBeenCalledWith('f-1');
    expect(
      screen.queryByTestId('favorite-folder-panel-f-1')
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /My bugs/ })).toBeInTheDocument();
  });
});
