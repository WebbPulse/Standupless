/**
 * The reactions on one issue or comment: the groups already there, and a
 * picker offering any emoji, led by the quick picks.
 *
 * A comment read carries its groups inline, so a thread passes them in and
 * stays one request rather than one per row. An issue read does not carry
 * them, because `Issue` is the M2 shape and M3 does not extend it, so the
 * issue page omits the prop and this reads the reactions route itself.
 *
 * The row itself is `ReactionGroups`, shared with project update threads.
 *
 * A comment is partitioned by its issue, so a comment target carries `issueId`
 * on every read and write; the API answers 404 without it. A comment on a
 * document carries `documentId` in its place.
 */

import React from 'react';
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
import { reactionsKey } from '../../lib/queryKeys';
import type { QueryKey } from '@webbpulse/api-client/react';
import type { ReactionGroup, ReactionTarget } from '../../types/Api';
import ReactionGroups from './ReactionGroups';

/** Props for ReactionBar: the target, its groups and what to refetch after. */
export interface ReactionBarProps {
  workspaceId: string;
  targetId: string;
  targetKind: ReactionTarget;
  /** The issue a comment target was written on. Required for a comment. */
  issueId?: string;
  /** The document a comment target was written on, sent in place of `issueId`. */
  documentId?: string;
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
  documentId,
  reactions,
  canReact,
  refetchKey,
}) => {
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
        ...(documentId !== undefined
          ? { document_id: documentId }
          : issueId === undefined
            ? {}
            : { issue_id: issueId }),
      };
      if (reacted) {
        await removeReaction(workspaceId, target);
        return;
      }
      await addReaction(workspaceId, target);
    },
    invalidates
  );

  return (
    <ReactionGroups
      reactions={shown}
      canReact={canReact}
      onToggle={toggle}
      error={error}
    />
  );
};

export default ReactionBar;
