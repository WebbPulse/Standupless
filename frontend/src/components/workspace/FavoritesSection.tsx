/**
 * The sidebar's Favorites: the issues, projects, cycles, views, teams,
 * documents and initiatives the caller starred, in their own order. It sits
 * under the caller's own entries, as in Linear, and is left out entirely while
 * nothing is starred.
 *
 * A row drags to a new place, Alt with an arrow key moves it from the keyboard,
 * and its menu offers the same moves for a touch screen beside removing it. The
 * new order shows at once and the server keeps it per person and workspace, so
 * it follows them to every device.
 */

import React, { useState } from 'react';
import { LuEllipsis, LuFileText, LuGoal, LuRefreshCcw } from 'react-icons/lu';
import { NavLink } from 'react-router-dom';
import { useFavorites } from '../../hooks/useFavorites';
import { cn } from '../../lib/cn';
import { favoriteHref } from '../../lib/favorites';
import { PROJECT_ICON_GLYPHS } from '../../lib/projectLook';
import type { ViewColor } from '../../api/views';
import type { FavoriteRead, ProjectIconName, TeamRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import { IconButton } from '../ui/button';
import Menu, { MenuItem, MenuSeparator } from '../ui/menu';
import ProjectIcon from '../planning/ProjectIcon';
import StatusIcon from '../ui/StatusIcon';
import ViewIcon from '../views/ViewIcon';

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
const FavoriteGlyph: React.FC<{
  favorite: FavoriteRead;
  teams: readonly TeamRead[] | null;
}> = ({ favorite, teams }) => {
  switch (favorite.kind) {
    case 'issue':
      return (
        <StatusIcon status={favorite.status ?? undefined} className={GLYPH} />
      );
    case 'project':
      return (
        <ProjectIcon
          icon={isProjectIcon(favorite.icon) ? favorite.icon : null}
          color={favorite.color ?? null}
          className="h-4 w-4 [&>svg]:h-3 [&>svg]:w-3"
        />
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
      return <LuFileText className={GLYPH} aria-hidden="true" />;
    case 'initiative':
      return <LuGoal className={GLYPH} aria-hidden="true" />;
    default:
      return null;
  }
};

/** Moves the row at `from` to `to`, or answers null when nothing would change. */
const moveRow = (
  rows: readonly FavoriteRead[],
  from: number,
  to: number
): FavoriteRead[] | null => {
  if (from === to || to < 0 || to >= rows.length) return null;
  const next = [...rows];
  const [moving] = next.splice(from, 1);
  if (moving === undefined) return null;
  next.splice(to, 0, moving);
  return next;
};

/** The caller's favorites in the sidebar, or nothing while none are starred. */
export const FavoritesSection: React.FC<FavoritesSectionProps> = ({
  workspaceId,
  slug,
  teams,
  rowClass,
  heading,
  onNavigate,
}) => {
  const { favorites, remove, reorder } = useFavorites(workspaceId);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const rows = (favorites ?? []).filter(
    (favorite) => favoriteHref(slug, favorite) !== null
  );
  if (rows.length === 0) return null;
  const canReorder = rows.length > 1;

  const moveTo = (from: number, to: number, focus: boolean): void => {
    const next = moveRow(rows, from, to);
    const moving = rows[from];
    if (next === null || moving === undefined) return;
    setAnnouncement(
      `Moved ${moving.title} to position ${String(to + 1)} of ${String(next.length)}.`
    );
    if (focus) {
      globalThis.requestAnimationFrame(() => {
        document.getElementById(rowId(moving))?.focus();
      });
    }
    void reorder(next);
  };

  const endDrag = (): void => {
    setDragFrom(null);
    setDragOver(null);
  };

  return (
    <section aria-labelledby="sidebar-favorites">
      {heading}
      <div className="space-y-px" data-testid="sidebar-favorites">
        {rows.map((favorite, index) => {
          const href = favoriteHref(slug, favorite) ?? '';
          const dropEdge =
            dragFrom === null || dragOver !== index || dragOver === dragFrom
              ? null
              : index < dragFrom
                ? 'before'
                : 'after';
          return (
            <div
              key={rowId(favorite)}
              className={cn(
                'group/favorite relative',
                dragFrom === index && 'opacity-50'
              )}
              data-testid={rowId(favorite)}
              draggable={canReorder}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', rowId(favorite));
                setDragFrom(index);
              }}
              onDragEnter={() => {
                if (dragFrom !== null) setDragOver(index);
              }}
              onDragOver={(event) => {
                if (canReorder) event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragFrom !== null) moveTo(dragFrom, index, false);
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
                title={
                  favorite.issue_key
                    ? `${favorite.issue_key} ${favorite.title}`
                    : favorite.title
                }
                className={(state) =>
                  cn(
                    rowClass(state),
                    'pr-8 group-data-[pointer]/nav:hover:text-text pointer-coarse:pr-12'
                  )
                }
                onClick={onNavigate}
                onKeyDown={(event) => {
                  if (!canReorder || !event.altKey) return;
                  if (event.key === 'ArrowUp' && index > 0) {
                    event.preventDefault();
                    moveTo(index, index - 1, true);
                  }
                  if (event.key === 'ArrowDown' && index < rows.length - 1) {
                    event.preventDefault();
                    moveTo(index, index + 1, true);
                  }
                }}
                aria-keyshortcuts={
                  canReorder ? 'Alt+ArrowUp Alt+ArrowDown' : undefined
                }
              >
                <FavoriteGlyph favorite={favorite} teams={teams} />
                <span className="min-w-0 truncate">
                  {favorite.title === '' && favorite.issue_key
                    ? favorite.issue_key
                    : favorite.title}
                </span>
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
                      .catch(() => undefined);
                  }}
                >
                  Copy link
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
                {canReorder && index < rows.length - 1 && (
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
                  onSelect={() => {
                    void remove(favorite.kind, favorite.target_id);
                  }}
                >
                  Remove from favorites
                </MenuItem>
              </Menu>
            </div>
          );
        })}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    </section>
  );
};

export default FavoritesSection;
