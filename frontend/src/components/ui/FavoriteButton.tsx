/**
 * The star that adds the page's subject to the caller's sidebar Favorites, or
 * takes it out. Mounting it also binds Shift F and lists the toggle in the
 * command palette, so a favorite is one key away wherever there is a star.
 */

import React from 'react';
import { LuStar } from 'react-icons/lu';
import { useFavorites } from '../../hooks/useFavorites';
import { useShortcut, type ShortcutScope } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import { showToast } from '../../lib/toast';
import type { FavoritePreview } from '../../lib/favorites';
import type { FavoriteKind } from '../../types/Api';
import { IconButton } from './button';

/** The keys the favorite toggle answers to. */
export const FAVORITE_SHORTCUT = 'shift+f';

/** Props for FavoriteButton: what the star stars. */
export interface FavoriteButtonProps {
  workspaceId: string;
  kind: FavoriteKind;
  targetId: string;
  /** The name the new sidebar row shows until the favorites read answers. */
  title: string;
  /** The issue key or team prefix the new row links with before the read answers. */
  preview?: FavoritePreview;
  /** The cycle's team, needed only for a cycle. */
  teamId?: string | null | undefined;
  /** Where the shortcut applies. An issue page binds it in the issue scope. */
  scope?: ShortcutScope;
  /** False to draw the star without binding the shortcut, for a second star on one page. */
  bindShortcut?: boolean;
  className?: string;
}

/** A star toggle for one favorite target. */
export const FavoriteButton: React.FC<FavoriteButtonProps> = ({
  workspaceId,
  kind,
  targetId,
  title,
  preview,
  teamId = null,
  scope = 'page',
  bindShortcut = true,
  className = '',
}) => {
  const { isFavorite, toggle } = useFavorites(workspaceId);
  const starred = isFavorite(kind, targetId);
  const label = starred ? 'Remove from favorites' : 'Add to favorites';

  const run = (): void => {
    void toggle(
      { kind, target_id: targetId, team_id: teamId },
      title,
      preview
    ).then((now) => {
      if (now !== starred) {
        showToast(now ? 'Added to favorites' : 'Removed from favorites');
      }
    });
  };

  useShortcut({
    keys: FAVORITE_SHORTCUT,
    label,
    scope,
    group: scope === 'issue' ? 'Issue' : 'General',
    enabled: bindShortcut && workspaceId !== '' && targetId !== '',
    handler: (event) => {
      event?.preventDefault();
      run();
    },
  });

  return (
    <IconButton
      label={label}
      size="sm"
      aria-pressed={starred}
      aria-keyshortcuts={bindShortcut ? 'Shift+F' : undefined}
      className={className}
      onClick={run}
    >
      <LuStar
        aria-hidden="true"
        className={cn('h-3.5 w-3.5', starred && 'fill-current text-warning')}
      />
    </IconButton>
  );
};

export default FavoriteButton;
