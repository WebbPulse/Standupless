/**
 * The "Add to favorites folder" items of a sidebar row's menu: the keyboard
 * way to do what dropping the row on a favorites folder does. Picking a folder
 * stars the target there, or moves it there when it is already a favorite.
 */

import React from 'react';
import { LuFolder } from 'react-icons/lu';
import { useFavorites } from '../../hooks/useFavorites';
import { sameFavorite, type FavoritePreview } from '../../lib/favorites';
import { showToast } from '../../lib/toast';
import type { FavoriteRef } from '../../types/Api';
import { MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';

/** Props for AddToFavoriteFolder. */
export interface AddToFavoriteFolderProps {
  workspaceId: string;
  target: FavoriteRef;
  /** The title the new favorite draws until the read answers. */
  title: string;
  preview?: FavoritePreview;
}

/** One menu item per favorites folder the target is not already in, or nothing when there is none. */
export const AddToFavoriteFolder: React.FC<AddToFavoriteFolderProps> = ({
  workspaceId,
  target,
  title,
  preview,
}) => {
  const { favorites, folders, place } = useFavorites(workspaceId);
  const current = (favorites ?? []).find((row) =>
    sameFavorite(row, target.kind, target.target_id)
  );
  const choices = (folders ?? []).filter(
    (folder) => folder.folder_id !== current?.folder_id
  );
  if (choices.length === 0) return null;
  return (
    <>
      <MenuSeparator />
      <MenuLabel>Add to favorites folder</MenuLabel>
      {choices.map((folder) => (
        <MenuItem
          key={folder.folder_id}
          textValue={folder.name}
          onSelect={() => {
            void place(target, title, folder.folder_id, preview).then(
              (placed) => {
                if (placed) showToast(`Added to ${folder.name}`);
              }
            );
          }}
        >
          <LuFolder className="h-3.5 w-3.5" aria-hidden="true" />
          {folder.name}
        </MenuItem>
      ))}
    </>
  );
};

export default AddToFavoriteFolder;
