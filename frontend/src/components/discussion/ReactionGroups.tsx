/**
 * A row of reaction groups and the picker that adds one, with no idea where
 * the reactions are stored. The issue and comment bar wraps it around the
 * discussion routes, and a project update's thread wraps it around the update
 * thread routes, so both read and toggle the same way.
 *
 * Each group shows its emoji and count, pressed when the reader reacted with
 * it, and clicking it toggles the reader's own reaction.
 */

import React, { useState } from 'react';
import { LuSmilePlus } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { normalizeReaction, reactionLabel } from '../../lib/reactions';
import type { ReactionGroup } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import Popover from '../ui/popover';
import EmojiPicker from './EmojiPicker';

/** Props for ReactionGroups: the groups and how to toggle one. */
export interface ReactionGroupsProps {
  reactions: ReactionGroup[];
  canReact: boolean;
  /** Adds the reader's reaction, or takes it back when `reacted` is true. */
  onToggle: (emoji: string, reacted: boolean) => Promise<unknown>;
  /** The last toggle's failure, or null. */
  error?: unknown;
}

/** The reaction groups on one target and the picker that adds to them. */
export const ReactionGroups: React.FC<ReactionGroupsProps> = ({
  reactions,
  canReact,
  onToggle,
  error = null,
}) => {
  const [picking, setPicking] = useState(false);
  const groups = reactions.filter((group) => group.count > 0);
  const held = new Set(
    groups
      .filter((group) => group.reacted)
      .map((group) => normalizeReaction(group.emoji))
  );

  return (
    <div className="space-y-1">
      {error !== null && error !== undefined && (
        <ErrorAlert
          message={errorMessage(error, 'Could not change that reaction.')}
        />
      )}

      <div className="flex flex-wrap items-center gap-1">
        {groups.map((group) => (
          <button
            key={group.emoji}
            type="button"
            disabled={!canReact}
            aria-pressed={group.reacted}
            aria-label={reactionLabel(group.emoji, group.count)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors duration-100 select-none disabled:cursor-not-allowed disabled:opacity-50',
              group.reacted
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line bg-bg text-text-muted hover:bg-raised hover:text-text'
            )}
            onClick={() => {
              void onToggle(group.emoji, group.reacted).catch(() => undefined);
            }}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span>{group.count}</span>
          </button>
        ))}

        {canReact && (
          <Popover
            label="Choose a reaction"
            open={picking}
            onOpenChange={setPicking}
            trigger={(props) => (
              <IconButton
                label="Add a reaction"
                size="sm"
                className="rounded-full"
                {...props}
              >
                <LuSmilePlus className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            <EmojiPicker
              held={held}
              onPick={(emoji) => {
                setPicking(false);
                void onToggle(emoji, held.has(normalizeReaction(emoji))).catch(
                  () => undefined
                );
              }}
            />
          </Popover>
        )}
      </div>
    </div>
  );
};

export default ReactionGroups;
