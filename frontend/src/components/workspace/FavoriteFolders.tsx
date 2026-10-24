/**
 * The named folders inside the sidebar's Favorites. Each folder collapses and
 * remembers that per viewer and workspace, renames in place, drags to a new
 * place among the folders, and takes a favorite dropped onto it. Deleting one
 * never unstars anything: its favorites move back to the top level.
 */

import React, { useRef, useState } from 'react';
import {
  LuChevronRight,
  LuEllipsis,
  LuFolder,
  LuFolderOpen,
} from 'react-icons/lu';
import { cn } from '../../lib/cn';
import type { FavoriteFolderRead } from '../../types/Api';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import { TruncatedText } from '../ui/truncated-text';

/** Where the collapsed favorite folders are remembered, one entry per workspace. */
export const collapsedFoldersKey = (workspaceId: string): string =>
  `standupless.sidebar.favoriteFolders.${workspaceId}`;

/** The folders this viewer collapsed, or none when nothing was kept or storage is blocked. */
const readCollapsed = (workspaceId: string): string[] => {
  if (workspaceId === '') return [];
  try {
    const raw = globalThis.localStorage.getItem(
      collapsedFoldersKey(workspaceId)
    );
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((row): row is string => typeof row === 'string');
  } catch {
    return [];
  }
};

/** Keeps the collapsed folders for the next visit, ignoring blocked storage. */
const writeCollapsed = (workspaceId: string, ids: string[]): void => {
  if (workspaceId === '') return;
  try {
    globalThis.localStorage.setItem(
      collapsedFoldersKey(workspaceId),
      JSON.stringify(ids)
    );
  } catch {
    return;
  }
};

/** The id of a folder's toggle, so a keyboard move can keep focus on it. */
export const folderToggleId = (folderId: string): string =>
  `favorite-folder-${folderId}`;

/** Moves the folder at `from` to `to`, or answers null when nothing would change. */
const moveFolder = (
  folders: readonly FavoriteFolderRead[],
  from: number,
  to: number
): FavoriteFolderRead[] | null => {
  if (from === to || to < 0 || to >= folders.length) return null;
  const next = [...folders];
  const [moving] = next.splice(from, 1);
  if (moving === undefined) return null;
  next.splice(to, 0, moving);
  return next;
};

/** Props for FavoriteFolders. */
export interface FavoriteFoldersProps {
  workspaceId: string;
  folders: readonly FavoriteFolderRead[];
  /** The favorite rows inside one folder, or an empty list when it holds none. */
  renderFavorites: (folderId: string) => React.ReactNode[];
  /** The folder whose name is being edited, such as one just created. */
  renaming: string | null;
  onRenamingChange: (folderId: string | null) => void;
  onRename: (folderId: string, name: string) => void;
  onDelete: (folderId: string) => void;
  onReorder: (next: FavoriteFolderRead[]) => void;
  /** Whether a favorite is being dragged, so a folder row takes the drop. */
  favoriteDragging: boolean;
  /** Moves the dragged favorite into a folder. */
  onFavoriteDrop: (folderId: string) => void;
  /** Says a change out loud for screen readers. */
  onAnnounce: (message: string) => void;
}

/** A folder's name as an input, committing on Enter or blur and cancelling on Escape. */
const RenameInput: React.FC<{
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}> = ({ name, onCommit, onCancel }) => {
  const done = useRef(false);
  const finish = (value: string | null): void => {
    if (done.current) return;
    done.current = true;
    const cleaned = value?.trim() ?? '';
    if (cleaned === '' || cleaned === name) onCancel();
    else onCommit(cleaned);
  };
  return (
    <input
      aria-label="Folder name"
      defaultValue={name}
      maxLength={80}
      autoFocus
      onFocus={(event) => {
        event.currentTarget.select();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
      onBlur={(event) => {
        finish(event.currentTarget.value);
      }}
      className="h-7 w-full min-w-0 rounded-sm border border-accent bg-surface px-2 text-sm text-text outline-none pointer-coarse:h-11"
    />
  );
};

/** The caller's favorite folders, each with the favorites it holds. */
export const FavoriteFolders: React.FC<FavoriteFoldersProps> = ({
  workspaceId,
  folders,
  renderFavorites,
  renaming,
  onRenamingChange,
  onRename,
  onDelete,
  onReorder,
  favoriteDragging,
  onFavoriteDrop,
  onAnnounce,
}) => {
  const [collapsed, setCollapsed] = useState<string[]>(() =>
    readCollapsed(workspaceId)
  );
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const canReorder = folders.length > 1;

  const toggle = (folderId: string): void => {
    const next = collapsed.includes(folderId)
      ? collapsed.filter((id) => id !== folderId)
      : [...collapsed, folderId];
    setCollapsed(next);
    writeCollapsed(workspaceId, next);
  };

  const moveTo = (from: number, to: number, focus: boolean): void => {
    const next = moveFolder(folders, from, to);
    const moving = folders[from];
    if (next === null || moving === undefined) return;
    onAnnounce(
      `Moved folder ${moving.name} to position ${String(to + 1)} of ${String(next.length)}.`
    );
    if (focus) {
      globalThis.requestAnimationFrame(() => {
        document.getElementById(folderToggleId(moving.folder_id))?.focus();
      });
    }
    onReorder(next);
  };

  const endDrag = (): void => {
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <>
      {folders.map((folder, index) => {
        const isOpen = !collapsed.includes(folder.folder_id);
        const children = renderFavorites(folder.folder_id);
        const panelId = `favorite-folder-panel-${folder.folder_id}`;
        const dropEdge =
          dragFrom === null || dragOver !== index || dragOver === dragFrom
            ? null
            : index < dragFrom
              ? 'before'
              : 'after';
        const takesFavorite = favoriteDragging && dragOver === index;
        return (
          <div key={folder.folder_id} data-testid={panelId}>
            <div
              className={cn(
                'group/folder relative',
                dragFrom === index && 'opacity-50'
              )}
              data-testid={folderToggleId(folder.folder_id)}
              draggable={canReorder && renaming !== folder.folder_id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(
                  'text/plain',
                  folderToggleId(folder.folder_id)
                );
                setDragFrom(index);
              }}
              onDragEnter={() => {
                if (dragFrom !== null || favoriteDragging) setDragOver(index);
              }}
              onDragLeave={(event) => {
                const into = event.relatedTarget;
                if (!favoriteDragging) return;
                if (
                  into instanceof Node &&
                  event.currentTarget.contains(into)
                ) {
                  return;
                }
                setDragOver((current) => (current === index ? null : current));
              }}
              onDragOver={(event) => {
                if (dragFrom !== null || favoriteDragging) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragFrom !== null) moveTo(dragFrom, index, false);
                else if (favoriteDragging) onFavoriteDrop(folder.folder_id);
                endDrag();
              }}
              onDragEnd={endDrag}
            >
              {dropEdge !== null && (
                <span
                  aria-hidden="true"
                  data-testid="favorite-folder-drop-indicator"
                  className={cn(
                    'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-accent',
                    dropEdge === 'before' ? '-top-px' : '-bottom-px'
                  )}
                />
              )}
              {renaming === folder.folder_id ? (
                <RenameInput
                  name={folder.name}
                  onCommit={(name) => {
                    onRenamingChange(null);
                    onRename(folder.folder_id, name);
                  }}
                  onCancel={() => {
                    onRenamingChange(null);
                  }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    id={folderToggleId(folder.folder_id)}
                    onClick={() => {
                      toggle(folder.folder_id);
                    }}
                    onDoubleClick={() => {
                      onRenamingChange(folder.folder_id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'F2') {
                        event.preventDefault();
                        onRenamingChange(folder.folder_id);
                        return;
                      }
                      if (!canReorder || !event.altKey) return;
                      if (event.key === 'ArrowUp' && index > 0) {
                        event.preventDefault();
                        moveTo(index, index - 1, true);
                      }
                      if (
                        event.key === 'ArrowDown' &&
                        index < folders.length - 1
                      ) {
                        event.preventDefault();
                        moveTo(index, index + 1, true);
                      }
                    }}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    aria-keyshortcuts={
                      canReorder ? 'Alt+ArrowUp Alt+ArrowDown F2' : 'F2'
                    }
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-sm pr-8 pl-2 text-sm text-text-muted transition-colors duration-100 pointer-coarse:h-11 pointer-coarse:pr-12',
                      'group-data-[pointer]/nav:hover:bg-raised/70 group-data-[pointer]/nav:hover:text-text',
                      'focus-visible:bg-raised/70 focus-visible:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none active:bg-line',
                      takesFavorite && 'bg-raised text-text ring-1 ring-accent'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
                    >
                      {isOpen ? (
                        <LuFolderOpen className="h-3.5 w-3.5" />
                      ) : (
                        <LuFolder className="h-3.5 w-3.5" />
                      )}
                    </span>
                    <TruncatedText className="min-w-0 text-left">
                      {folder.name}
                    </TruncatedText>
                    <LuChevronRight
                      aria-hidden="true"
                      className={cn(
                        'h-3 w-3 shrink-0 text-text-faint transition-transform duration-100',
                        isOpen && 'rotate-90'
                      )}
                    />
                  </button>
                  <Menu
                    label={`${folder.name} folder actions`}
                    align="end"
                    className="absolute top-0.5 right-1 pointer-coarse:top-0 pointer-coarse:right-0"
                    trigger={(props) => (
                      <IconButton
                        label="Folder options"
                        size="sm"
                        className="h-6 w-6 opacity-0 group-focus-within/folder:opacity-100 group-hover/folder:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                        {...props}
                      >
                        <LuEllipsis className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  >
                    <MenuItem
                      onSelect={() => {
                        onRenamingChange(folder.folder_id);
                      }}
                    >
                      Rename
                    </MenuItem>
                    {canReorder && index > 0 && (
                      <MenuItem
                        onSelect={() => {
                          moveTo(index, index - 1, false);
                        }}
                      >
                        Move up
                      </MenuItem>
                    )}
                    {canReorder && index < folders.length - 1 && (
                      <MenuItem
                        onSelect={() => {
                          moveTo(index, index + 1, false);
                        }}
                      >
                        Move down
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={() => {
                        onDelete(folder.folder_id);
                      }}
                    >
                      Delete folder
                    </MenuItem>
                  </Menu>
                </>
              )}
            </div>
            {isOpen && (
              <div id={panelId} className="space-y-px">
                {children.length > 0 ? (
                  children
                ) : (
                  <p className="flex h-7 items-center pl-8 text-xs text-text-faint pointer-coarse:h-11">
                    No favorites
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
};

export default FavoriteFolders;
