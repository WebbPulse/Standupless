/**
 * What a project update's thread shows before the server answers: a reaction
 * toggled on an update from an older feed page is not re-read by the feed's
 * first page poll, so the card applies the toggle to the groups it holds.
 */

import { normalizeReaction } from './reactions';
import type { ReactionGroup } from '../types/Api';

/** The groups after the reader adds an emoji, or takes it back when `reacted` is true. */
export const toggleReactionGroup = (
  groups: ReactionGroup[],
  emoji: string,
  reacted: boolean
): ReactionGroup[] => {
  const key = normalizeReaction(emoji);
  const found = groups.some((group) => normalizeReaction(group.emoji) === key);
  if (!found) {
    return reacted
      ? groups
      : [...groups, { emoji, count: 1, user_ids: [], reacted: true }];
  }
  return groups
    .map((group) => {
      if (normalizeReaction(group.emoji) !== key) return group;
      if (reacted) {
        return group.reacted
          ? { ...group, count: group.count - 1, reacted: false }
          : group;
      }
      return group.reacted
        ? group
        : { ...group, count: group.count + 1, reacted: true };
    })
    .filter((group) => group.count > 0);
};
