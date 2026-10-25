/**
 * Context object for the members a rendered mention names, so a mention can
 * open a card with the person's name, avatar and status. Kept apart from the
 * provider so the provider file exports only components and stays refresh safe.
 */

import { createContext, useContext } from 'react';
import type { MemberRead } from '../types/Api';

/** The member every known handle names, keyed by the lowercased handle. */
export const MentionMembersContext = createContext<
  ReadonlyMap<string, MemberRead>
>(new Map());

/** The member a mention written as `handle` names, or undefined when none is known. */
export const useMentionMember = (handle: string): MemberRead | undefined =>
  useContext(MentionMembersContext).get(handle.toLowerCase());

/** Every workspace member keyed by user id, so an avatar or a name can open the person's card. */
export const MembersByIdContext = createContext<
  ReadonlyMap<string, MemberRead>
>(new Map());

/** The workspace member with `userId`, or undefined when none is known. */
export const useMemberById = (
  userId: string | null | undefined
): MemberRead | undefined => {
  const members = useContext(MembersByIdContext);
  return userId === null || userId === undefined
    ? undefined
    : members.get(userId);
};
