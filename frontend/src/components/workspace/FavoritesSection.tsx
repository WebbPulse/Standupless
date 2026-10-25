/**
 * The sidebar's Favorites: the issues, projects, cycles, views, teams,
 * documents and initiatives the caller starred, in their own order. It sits
 * under the caller's own entries, as in Linear, and is left out entirely while
 * nothing is starred and no folder exists.
 *
 * A row drags to a new place, Alt with an arrow key moves it from the keyboard,
 * and its menu offers the same moves for a touch screen beside removing it. The
 * new order shows at once and the server keeps it per person and workspace, so
 * it follows them to every device. The heading's menu makes a folder, a row's
 * menu moves it into one, and dropping a row on a folder does the same.
 *
 * A team's header or page dragged from elsewhere in the sidebar stars the team
 * where it is dropped: on the heading for the top level or on a folder. While
 * nothing is starred the heading still shows during such a drag, so there is
 * always somewhere to drop it.
 */

import React, { useRef, useState } from 'react';
import { LuEllipsis, LuFolder, LuGoal, LuRefreshCcw } from 'react-icons/lu';
import { NavLink } from 'react-router-dom';
import { useFavorites } from '../../hooks/useFavorites';
import {
  useSidebarFavoriteDrag,
  type SidebarFavoriteDrag,
} from '../../hooks/useSidebarFavoriteDrag';
import { cn } from '../../lib/cn';
import { favoriteHref, sameFavorite } from '../../lib/favorites';
import { showErrorToast, showToast } from '../../lib/toast';
import { PROJECT_ICON_GLYPHS, projectGlyph } from '../../lib/projectLook';
import type { ViewColor } from '../../api/views';
import type { FavoriteRead, ProjectIconName, TeamRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import StatusIcon from '../ui/StatusIcon';
import { TruncatedText } from '../ui/truncated-text';
import ViewIcon from '../views/ViewIcon';
import DocumentIcon from '../planning/DocumentIcon';
import FavoriteFolders from './FavoriteFolders';
import type { SidebarIssueDrop } from '../../hooks/useSidebarIssueDrop';
import { favoriteDropTarget } from '../../lib/sidebarIssueDrop';

/** Props for FavoritesSection. */
export interface FavoritesSectionProps {
  workspaceId: string;
  slug: string;
  /** The workspace's teams, which a team favorite draws its avatar from. */
  teams: readonly TeamRead[] | null;
  /** The look of a row, lit when it is the current page. */
  rowClass: (state: { isActive: boolean }) => string;
  /** The heading over the section. */
  heading: React.ReactNode;
  onNavigate?: (() => void) | undefined;
  /**
   * Lets a favorited team, project or cycle take issues dragged out of a list
   * or board. Unset, no favorite takes a drop of issues.
   */
  issueDrop?: SidebarIssueDrop | undefined;
}

const GLYPH = 'h-3.5 w-3.5 shrink-0';

/** The id of a favorite's link, so a keyboard move can keep focus on it. */
const rowId = (favorite: FavoriteRead): string =>
  `favorite-${favorite.kind}-${favorite.target_id}`;

/** Whether a stored project icon name is one this client can draw. */
const isProjectIcon = (
  icon: string | null | undefined
): icon is ProjectIconName =>
  typeof icon === 'string' && icon in PROJECT_ICON_GLYPHS;

/** The small mark a favorite leads with, matching where it lives elsewhere in the app. */
const FavoriteMark: React.FC<{
  favorite: FavoriteRead;
  teams: readonly TeamRead[] | null;
}> = ({ favorite, teams }) => {
  switch (favorite.kind) {
    case 'issue':
      return (
        <StatusIcon status={favorite.status ?? undefined} className={GLYPH} />
      );
    case 'project':
      return React.createElement(
        projectGlyph(isProjectIcon(favorite.icon) ? favorite.icon : null),
        {
          'aria-hidden': true,
          className: cn(GLYPH, !favorite.color && 'text-text-muted'),
          style: favorite.color ? { color: favorite.color } : undefined,
        }
      );
    case 'view':
      return (
        <ViewIcon
          icon={favorite.icon}
          color={(favorite.color ?? null) as ViewColor | null}
          className={GLYPH}
        />
      );
    case 'team': {
      const team = teams?.find((row) => row.id === favorite.target_id);
      return (
        <Avatar
          name={favorite.title}
          src={team?.icon_url}
          size="xs"
          shape="square"
        />
      );
    }
    case 'cycle':
      return <LuRefreshCcw className={GLYPH} aria-hidden="true" />;
    case 'document':
      return <DocumentIcon icon={favorite.icon ?? null} className={GLYPH} />;
    case 'initiative':
      return <LuGoal className={GLYPH} aria-hidden="true" />;
    default:
      return null;
  }
};

/** A favorite's mark in one 16px box, so every title starts on the same line whatever the kind. */
const FavoriteGlyph: React.FC<{
  favorite: FavoriteRead;
  teams: readonly TeamRead[] | null;
}> = ({ favorite, teams }) => (
  <span
    aria-hidden="true"
    className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
  >
    <FavoriteMark favorite={favorite} teams={teams} />
  </span>
);

/**
 * Moves `moving` onto `target`'s place and into its folder, or answers null
 * when nothing would change. It lands after `target` when it came from above.
 */
const placeRow = (
  rows: readonly FavoriteRead[],
  moving: FavoriteRead,
  target: FavoriteRead,
  folderId: string | null
): FavoriteRead[] | null => {
  const from = rows.indexOf(moving);
  const to = rows.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = rows.filter((row) => row !== moving);
  const at = next.indexOf(target) + (from < to ? 1 : 0);
  next.splice(at, 0, { ...moving, folder_id: folderId });
  return next;
};

/** The caller's favorites in the sidebar, or nothing while none are starred and no folder exists. */
export const FavoritesSection: React.FC<FavoritesSectionProps> = ({
  workspaceId,
  slug,
  teams,
  rowClass,
  heading,
  onNavigate,
  issueDrop,
}) => {
  const {
    favorites,
    place,
    remove,
    reorder,
    folders,
    createFolder,
    renameFolder,
    deleteFolder,
    reorderFolders,
  } = useFavorites(workspaceId);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [headingOver, setHeadingOver] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const sidebarDrag = useSidebarFavoriteDrag(anchor, teams);

  const folderList = folders ?? [];
  const known = new Set(folderList.map((folder) => folder.folder_id));
  const folderOf = (favorite: FavoriteRead): string | null =>
    typeof favorite.folder_id === 'string' && known.has(favorite.folder_id)
      ? favorite.folder_id
      : null;
  const rows = (favorites ?? []).filter(
    (favorite) => favoriteHref(slug, favorite) !== null
  );
  const dragging =
    rows.find((favorite) => rowId(favorite) === draggingId) ?? null;
  const incoming = sidebarDrag.drag;
  if (rows.length === 0 && folderList.length === 0 && incoming === null) {
    return <span ref={anchor} hidden />;
  }
  const accepting = dragging !== null || incoming !== null;
  const groupOf = (folderId: string | null): FavoriteRead[] =>
    rows.filter((favorite) => folderOf(favorite) === folderId);

  const focusRow = (favorite: FavoriteRead): void => {
    globalThis.requestAnimationFrame(() => {
      document.getElementById(rowId(favorite))?.focus();
    });
  };

  const moveOnto = (
    moving: FavoriteRead,
    target: FavoriteRead,
    focus: boolean
  ): void => {
    const folderId = folderOf(target);
    const next = placeRow(rows, moving, target, folderId);
    if (next === null) return;
    const group = next.filter((favorite) => folderOf(favorite) === folderId);
    const position = group.findIndex((favorite) =>
      sameFavorite(favorite, moving.kind, moving.target_id)
    );
    setAnnouncement(
      `Moved ${moving.title} to position ${String(position + 1)} of ${String(group.length)}.`
    );
    if (focus) focusRow(moving);
    void reorder(next);
  };

  const moveToFolder = (
    moving: FavoriteRead,
    folderId: string | null
  ): void => {
    if (folderOf(moving) === folderId) return;
    const next = [
      ...rows.filter((favorite) => favorite !== moving),
      { ...moving, folder_id: folderId },
    ];
    const folder = folderList.find((row) => row.folder_id === folderId);
    setAnnouncement(
      folder === undefined
        ? `Moved ${moving.title} out of its folder.`
        : `Moved ${moving.title} to ${folder.name}.`
    );
    void reorder(next);
  };

  const endDrag = (): void => {
    setDraggingId(null);
    setDragOver(null);
    setHeadingOver(false);
    sidebarDrag.clear();
  };

  const placeIncoming = (
    item: SidebarFavoriteDrag,
    folderId: string | null
  ): void => {
    const existing = rows.find((favorite) =>
      sameFavorite(favorite, item.ref.kind, item.ref.target_id)
    );
    if (existing !== undefined && folderOf(existing) === folderId) return;
    const folder = folderList.find((row) => row.folder_id === folderId);
    setAnnouncement(
      folder === undefined
        ? `Added ${item.title} to favorites.`
        : `Added ${item.title} to ${folder.name}.`
    );
    void place(item.ref, item.title, folderId, item.preview);
  };

  const dropInto = (folderId: string | null): void => {
    if (dragging !== null) moveToFolder(dragging, folderId);
    else if (incoming !== null) placeIncoming(incoming, folderId);
    endDrag();
  };

  const copyLinks = (folderId: string): void => {
    const links = groupOf(folderId).flatMap((favorite) => {
      const href = favoriteHref(slug, favorite);
      return href === null ? [] : [`${globalThis.location.origin}${href}`];
    });
    if (links.length === 0) return;
    void globalThis.navigator.clipboard
      .writeText(links.join('\n'))
      .then(() => {
        showToast(
          links.length === 1
            ? 'Copied 1 link'
            : `Copied ${String(links.length)} links`
        );
      })
      .catch(() => {
        showErrorToast('Could not copy links.');
      });
  };

  const newFolder = async (): Promise<void> => {
    const created = await createFolder('New folder');
    if (created !== null) setRenaming(created.folder_id);
  };

  const renderRow = (
    favorite: FavoriteRead,
    group: readonly FavoriteRead[],
    index: number,
    nested: boolean
  ): React.ReactNode => {
    const href = favoriteHref(slug, favorite) ?? '';
    const canReorder = group.length > 1;
    const current = folderOf(favorite);
    const elsewhere = folderList.filter(
      (folder) => folder.folder_id !== current
    );
    const from = dragging === null ? -1 : rows.indexOf(dragging);
    const dropEdge =
      dragging === null || dragOver !== rowId(favorite) || dragging === favorite
        ? null
        : rows.indexOf(favorite) < from
          ? 'before'
          : 'after';
    const above = group[index - 1];
    const below = group[index + 1];
    const takesIssues = issueDrop?.handlersFor(
      favoriteDropTarget(favorite, teams)
    );
    return (
      <div
        key={rowId(favorite)}
        className={cn(
          'group/favorite relative',
          dragging === favorite && 'opacity-50'
        )}
        data-testid={rowId(favorite)}
        draggable
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', rowId(favorite));
          setDraggingId(rowId(favorite));
        }}
        onDragEnter={(event) => {
          if (takesIssues?.onDragOver(event) === true) return;
          if (dragging !== null) setDragOver(rowId(favorite));
        }}
        onDragOver={(event) => {
          if (takesIssues?.onDragOver(event) === true) return;
          if (dragging !== null) event.preventDefault();
        }}
        onDragLeave={takesIssues?.onDragLeave}
        onDrop={(event) => {
          if (takesIssues?.onDrop(event) === true) return;
          event.preventDefault();
          event.stopPropagation();
          if (dragging !== null) moveOnto(dragging, favorite, false);
          endDrag();
        }}
        onDragEnd={endDrag}
      >
        {dropEdge !== null && (
          <span
            aria-hidden="true"
            data-testid="favorite-drop-indicator"
            className={cn(
              'pointer-events-none absolute right-1 left-1 z-10 h-0.5 rounded-full bg-accent',
              dropEdge === 'before' ? '-top-px' : '-bottom-px'
            )}
          />
        )}
        <NavLink
          id={rowId(favorite)}
          to={href}
          end
          draggable={false}
          data-issue-drop={takesIssues?.over === true ? 'over' : undefined}
          title={
            favorite.issue_key
              ? `${favorite.issue_key} ${favorite.title}`
              : favorite.title
          }
          className={(state) =>
            cn(
              rowClass(state),
              'pr-8 group-data-[pointer]/nav:hover:text-text pointer-coarse:pr-12',
              nested && 'pl-8',
              takesIssues?.over === true &&
                'bg-raised text-text ring-1 ring-accent'
            )
          }
          onClick={onNavigate}
          onKeyDown={(event) => {
            if (!canReorder || !event.altKey) return;
            if (event.key === 'ArrowUp' && above !== undefined) {
              event.preventDefault();
              moveOnto(favorite, above, true);
            }
            if (event.key === 'ArrowDown' && below !== undefined) {
              event.preventDefault();
              moveOnto(favorite, below, true);
            }
          }}
          aria-keyshortcuts={
            canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined
          }
        >
          <FavoriteGlyph favorite={favorite} teams={teams} />
          <TruncatedText className="min-w-0">
            {favorite.title === '' && favorite.issue_key
              ? favorite.issue_key
              : favorite.title}
          </TruncatedText>
        </NavLink>
        <Menu
          label={`${favorite.title} favorite actions`}
          align="end"
          className="absolute top-0.5 right-1 pointer-coarse:top-0 pointer-coarse:right-0"
          trigger={(props) => (
            <IconButton
              label="Favorite options"
              size="sm"
              className="h-6 w-6 opacity-0 group-focus-within/favorite:opacity-100 group-hover/favorite:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              {...props}
            >
              <LuEllipsis className="h-3.5 w-3.5" />
            </IconButton>
          )}
        >
          <MenuItem
            onSelect={() => {
              void globalThis.navigator.clipboard
                .writeText(`${globalThis.location.origin}${href}`)
                .then(() => {
                  showToast('Link copied');
                })
                .catch(() => undefined);
            }}
          >
            Copy link
          </MenuItem>
          {above !== undefined && (
            <MenuItem
              onSelect={() => {
                moveOnto(favorite, above, false);
              }}
            >
              Move up
            </MenuItem>
          )}
          {below !== undefined && (
            <MenuItem
              onSelect={() => {
                moveOnto(favorite, below, false);
              }}
            >
              Move down
            </MenuItem>
          )}
          {(elsewhere.length > 0 || current !== null) && (
            <>
              <MenuSeparator />
              <MenuLabel>Move to folder</MenuLabel>
              {elsewhere.map((folder) => (
                <MenuItem
                  key={folder.folder_id}
                  textValue={folder.name}
                  onSelect={() => {
                    moveToFolder(favorite, folder.folder_id);
                  }}
                >
                  <LuFolder className="h-3.5 w-3.5" aria-hidden="true" />
                  {folder.name}
                </MenuItem>
              ))}
              {current !== null && (
                <MenuItem
                  onSelect={() => {
                    moveToFolder(favorite, null);
                  }}
                >
                  Move out of folder
                </MenuItem>
              )}
            </>
          )}
          <MenuSeparator />
          <MenuItem
            onSelect={() => {
              void remove(favorite.kind, favorite.target_id);
            }}
          >
            Remove from favorites
          </MenuItem>
        </Menu>
      </div>
    );
  };

  const top = groupOf(null);

  return (
    <section ref={anchor} aria-labelledby="sidebar-favorites">
      <div
        className={cn(
          'group/favorites-heading relative rounded-sm',
          accepting && headingOver && 'bg-raised ring-1 ring-accent'
        )}
        data-testid="favorites-heading"
        onDragEnter={() => {
          if (accepting) setHeadingOver(true);
        }}
        onDragLeave={(event) => {
          const into = event.relatedTarget;
          if (into instanceof Node && event.currentTarget.contains(into)) {
            return;
          }
          setHeadingOver(false);
        }}
        onDragOver={(event) => {
          if (accepting) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!accepting) return;
          event.preventDefault();
          dropInto(null);
        }}
      >
        {heading}
        <Menu
          label="Favorites actions"
          align="end"
          className="absolute top-0 right-1 pointer-coarse:top-2.5"
          trigger={(props) => (
            <IconButton
              label="Favorites options"
              size="sm"
              className="h-6 w-6 opacity-0 group-focus-within/favorites-heading:opacity-100 group-hover/favorites-heading:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
              {...props}
            >
              <LuEllipsis className="h-3.5 w-3.5" />
            </IconButton>
          )}
        >
          <MenuItem
            onSelect={() => {
              void newFolder();
            }}
          >
            New folder
          </MenuItem>
        </Menu>
      </div>
      <div className="space-y-px" data-testid="sidebar-favorites">
        <FavoriteFolders
          workspaceId={workspaceId}
          folders={folderList}
          renderFavorites={(folderId) => {
            const group = groupOf(folderId);
            return group.map((favorite, index) =>
              renderRow(favorite, group, index, true)
            );
          }}
          renaming={renaming}
          onRenamingChange={setRenaming}
          onRename={(folderId, name) => {
            void renameFolder(folderId, name);
          }}
          onDelete={(folderId) => {
            void deleteFolder(folderId);
          }}
          onReorder={(next) => {
            void reorderFolders(next);
          }}
          favoriteDragging={accepting}
          onFavoriteDrop={dropInto}
          onCopyLinks={copyLinks}
          onAnnounce={setAnnouncement}
        />
        {top.map((favorite, index) => renderRow(favorite, top, index, false))}
        {incoming !== null && rows.length === 0 && folderList.length === 0 && (
          <p className="flex h-7 items-center pl-2 text-xs text-text-faint pointer-coarse:h-11">
            Drop on Favorites to add {incoming.title}
          </p>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </section>
  );
};

export default FavoritesSection;
