/**
 * The reactions on one issue or comment: the groups already there, and a
 * picker offering any emoji, led by the quick picks.
 *
 * A comment read carries its groups inline, so a thread passes them in and
 * stays one request rather than one per row. An issue read does not carry
 * them, because `Issue` is the M2 shape and M3 does not extend it, so the
 * issue page omits the prop and this reads the reactions route itself.
 *
 * A comment is partitioned by its issue, so a comment target carries `issueId`
 * on every read and write; the API answers 404 without it.
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
import { normalizeReaction, reactionLabel } from '../../lib/reactions';
import type { QueryKey } from '@webbpulse/api-client/react';
import type { ReactionGroup, ReactionTarget } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import { IconButton } from '../ui/button';
import Popover from '../ui/popover';
import EmojiPicker from './EmojiPicker';

/** Props for ReactionBar: the target, its groups and what to refetch after. */
export interface ReactionBarProps {
  workspaceId: string;
  targetId: string;
  targetKind: ReactionTarget;
  /** The issue a comment target was written on. Required for a comment. */
  issueId?: string;
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
  issueId,
  reactions,
  canReact,
  refetchKey,
}) => {
  const [picking, setPicking] = useState(false);
  const auth = useQueryAuth();
  const isSelfRead = reactions === undefined;
  const ownKey = reactionsKey(targetKind, targetId);

  const { data: fetched } = usePolledQuery(
    ({ signal }) =>
      listReactions(workspaceId, targetId, targetKind, signal, issueId),
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
        ...(issueId === undefined ? {} : { issue_id: issueId }),
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
  const held = new Set(
    groups
      .filter((group) => group.reacted)
      .map((group) => normalizeReaction(group.emoji))
  );

  return (
    <div className="space-y-1">
      {error !== null && (
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
              void toggle(group.emoji, group.reacted).catch(() => undefined);
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
                void toggle(emoji, held.has(normalizeReaction(emoji))).catch(
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

export default ReactionBar;
