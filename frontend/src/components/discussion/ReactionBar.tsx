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
import {
  addReaction,
  listReactions,
  removeReaction,
} from '../../api/discussion';
import { errorMessage } from '../../lib/errors';
import { reactionsKey } from '../../lib/queryKeys';
import { REACTION_EMOJI, reactionLabel } from '../../lib/reactions';
import type { QueryKey } from '@webbpulse/api-client/react';
import type { ReactionGroup, ReactionTarget } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';

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

      <div className="flex flex-wrap items-center gap-1">
        {groups.map((group) => (
          <button
            key={group.emoji}
            type="button"
            disabled={!canReact}
            aria-pressed={group.reacted}
            aria-label={reactionLabel(group.emoji, group.count)}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 ${
              group.reacted
                ? 'border-sky-500 bg-sky-500/20 text-sky-200'
                : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'
            }`}
            onClick={() => {
              void toggle(group.emoji, group.reacted).catch(() => undefined);
            }}
          >
            <span aria-hidden="true">{group.emoji}</span>
            <span>{group.count}</span>
          </button>
        ))}

        {canReact && (
          <button
            type="button"
            aria-label="Add a reaction"
            aria-expanded={picking}
            className="rounded-full border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            onClick={() => {
              setPicking((open) => !open);
            }}
          >
            Add reaction
          </button>
        )}
      </div>

      {picking && canReact && (
        <div
          role="group"
          aria-label="Choose a reaction"
          className="flex flex-wrap gap-1 rounded-md border border-slate-700 bg-slate-900 p-2"
        >
          {REACTION_EMOJI.map((emoji) => {
            const held =
              groups.find((group) => group.emoji === emoji)?.reacted ?? false;
            return (
              <button
                key={emoji}
                type="button"
                aria-label={reactionLabel(emoji, 0)}
                className="rounded px-1.5 py-1 text-base hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
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
  );
};

export default ReactionBar;
