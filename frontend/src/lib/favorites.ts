/**
 * What every favorites consumer shares: the state shape the sidebar and the star
 * toggles read, and where a favorite links to. Kept out of the hook and the
 * provider so both can import it and each file stays refresh safe.
 */

import type {
  FavoriteFolderRead,
  FavoriteKind,
  FavoriteRead,
  FavoriteRef,
} from '../types/Api';
import {
  cyclePath,
  documentPath,
  initiativePath,
  issuePath,
  projectPath,
  teamPath,
  viewPath,
} from './paths';

/** What a star knows about its target beyond the title, so the new row links and draws before the read answers. */
export type FavoritePreview = Partial<
  Pick<
    FavoriteRead,
    'issue_key' | 'team_key_prefix' | 'status' | 'icon' | 'color'
  >
>;

/** The caller's favorites and the writes that change them. */
export interface FavoritesState {
  /** The favorites in sidebar order, or null before the first read. */
  favorites: FavoriteRead[] | null;
  /** Whether the caller starred this target. */
  isFavorite: (kind: FavoriteKind, targetId: string) => boolean;
  /**
   * Stars or unstars a target. `title` and `preview` draw the new row until
   * the read answers. Resolves to whether it is now a favorite.
   */
  toggle: (
    ref: FavoriteRef,
    title: string,
    preview?: FavoritePreview
  ) => Promise<boolean>;
  /**
   * Stars a target into a folder, or the top level for null, or moves it there
   * when it is already starred. Resolves to whether the write succeeded.
   */
  place: (
    ref: FavoriteRef,
    title: string,
    folderId: string | null,
    preview?: FavoritePreview
  ) => Promise<boolean>;
  /** Unstars one favorite. */
  remove: (kind: FavoriteKind, targetId: string) => Promise<void>;
  /** Puts the favorites in a new order, each in the folder its row names, shown at once. */
  reorder: (next: FavoriteRead[]) => Promise<void>;
  /** The caller's folders in sidebar order, or null before the first read. */
  folders: FavoriteFolderRead[] | null;
  /** Adds an empty folder last, resolving to it or null when the write failed. */
  createFolder: (name: string) => Promise<FavoriteFolderRead | null>;
  /** Renames one folder, shown at once. */
  renameFolder: (folderId: string, name: string) => Promise<void>;
  /** Deletes one folder, its favorites moving to the top level at once. */
  deleteFolder: (folderId: string) => Promise<void>;
  /** Puts the folders in a new order, shown at once. */
  reorderFolders: (next: FavoriteFolderRead[]) => Promise<void>;
}

/** A state with nothing starred and writes that do nothing, for outside a workspace. */
export const EMPTY_FAVORITES: FavoritesState = {
  favorites: null,
  isFavorite: () => false,
  toggle: () => Promise.resolve(false),
  place: () => Promise.resolve(false),
  remove: () => Promise.resolve(),
  reorder: () => Promise.resolve(),
  folders: null,
  createFolder: () => Promise.resolve(null),
  renameFolder: () => Promise.resolve(),
  deleteFolder: () => Promise.resolve(),
  reorderFolders: () => Promise.resolve(),
};

/** Whether two favorites name the same target. */
export const sameFavorite = (
  favorite: Pick<FavoriteRead, 'kind' | 'target_id'>,
  kind: FavoriteKind,
  targetId: string
): boolean => favorite.kind === kind && favorite.target_id === targetId;

/** The page one favorite opens, or null when its read lacks what the link needs. */
export const favoriteHref = (
  slug: string,
  favorite: FavoriteRead
): string | null => {
  const prefix = favorite.team_key_prefix ?? '';
  switch (favorite.kind) {
    case 'issue':
      return favorite.issue_key ? issuePath(slug, favorite.issue_key) : null;
    case 'project':
      return projectPath(slug, favorite.target_id);
    case 'cycle':
      return prefix === '' ? null : cyclePath(slug, prefix, favorite.target_id);
    case 'view':
      return viewPath(slug, favorite.target_id);
    case 'team':
      return prefix === '' ? null : teamPath(slug, prefix);
    case 'document':
      return documentPath(slug, favorite.target_id);
    case 'initiative':
      return initiativePath(slug, favorite.target_id);
    default:
      return null;
  }
};
