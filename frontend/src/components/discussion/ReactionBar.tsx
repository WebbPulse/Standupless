/**
 * The reactions on one issue or comment: the groups already there, and a
 * picker offering the allow list.
 *
 * A comment read carries its groups inline, so a thread passes them in and
 * stays one request rather than one per row. An issue read does not carry
 * them, because `Issue` is the M2 shape and M3 does not extend it, so the
 * issue page omits the prop and this reads the reactions route itself.
 */

import React, { useState } from 'react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { LuSmilePlus } from 'react-icons/lu';
import {
  addReaction,
  listReactions,
  removeReaction,
} from '../../api/discussion';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { reactionsKey } from '../../lib/queryKeys';
import { REACTION_EMOJI, reactionLabel } from '../../lib/reactions';
import type { QueryKey } from '@webbpulse/api-client/react';
import type { ReactionGroup, ReactionTarget } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';

/** Props for ReactionBar: the target, its groups and what to refetch after. */
export interface ReactionBarProps {
  workspaceId: string;
  targetId: string;
  targetKind: ReactionTarget;
  /** The groups from an inline read, or undefined to read them here. */
  reactions?: ReactionGroup[];
  canReact: boolean;
  /**
   * The key holding the read these groups came from, invalidated on a write.
   * Omitted when this reads its own groups, which invalidates its own key.
   */
  refetchKey?: QueryKey | readonly QueryKey[];
}

/** How often self-read groups poll, so a reaction by someone else appears. */
const POLL_MS = 60000;

/** Lists the reaction groups on a target and toggles the caller's own. */
export const ReactionBar: React.FC<ReactionBarProps> = ({
  workspaceId,
  targetId,
  targetKind,
  reactions,
  canReact,
  refetchKey,
}) => {
  const [picking, setPicking] = useState(false);
  const auth = useQueryAuth();
  const isSelfRead = reactions === undefined;
  const ownKey = reactionsKey(targetKind, targetId);

  const { data: fetched } = usePolledQuery(
    ({ signal }) => listReactions(workspaceId, targetId, targetKind, signal),
    {
      intervalMs: POLL_MS,
      enabled: isSelfRead && workspaceId !== '' && targetId !== '',
      queryKey: ownKey,
      auth,
    }
  );

  const shown = reactions ?? fetched ?? [];
  const invalidates = refetchKey ?? ownKey;

  const { mutate: toggle, error } = useMutationWithRefetch(
    async (emoji: string, reacted: boolean): Promise<void> => {
      const target = {
        target_id: targetId,
        target_kind: targetKind,
        emoji,
      };
      if (reacted) {
        await removeReaction(workspaceId, target);
        return;
      }
      await addReaction(workspaceId, target);
    },
    invalidates
  );

  const groups = shown.filter((group) => group.count > 0);

  return (
    <div className="space-y-1">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not change that reaction.')}
        />
      )}

      <div className="relative flex flex-wrap items-center gap-1">
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
              void toggle(group.emoji, group.reacted).catch(() => undefined);
            }}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span>{group.count}</span>
          </button>
        ))}

        {canReact && (
          <IconButton
            label="Add a reaction"
            size="sm"
            aria-expanded={picking}
            className="rounded-full"
            onClick={() => {
              setPicking((open) => !open);
            }}
          >
            <LuSmilePlus className="h-3.5 w-3.5" />
          </IconButton>
        )}

        {picking && canReact && (
          <div
            role="group"
            aria-label="Choose a reaction"
            className="absolute top-full left-0 z-40 mt-1 flex w-64 flex-wrap gap-0.5 rounded-md border border-line bg-overlay p-1.5 shadow-overlay"
          >
            {REACTION_EMOJI.map((emoji) => {
              const held =
                groups.find((group) => group.emoji === emoji)?.reacted ?? false;
              return (
                <button
                  key={emoji}
                  type="button"
                  aria-label={reactionLabel(emoji, 0)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-base transition-colors duration-100 hover:bg-raised"
                  onClick={() => {
                    setPicking(false);
                    void toggle(emoji, held).catch(() => undefined);
                  }}
                >
                  <span aria-hidden="true">{emoji}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReactionBar;
