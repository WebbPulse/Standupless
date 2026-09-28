/**
 * How the people an issue can name read in the interface. Kept out of the
 * components so the list, the detail page and the activity feed resolve an id
 * the same way, and so a component file exports only components.
 */

import type { MemberRead, TeamMemberRead } from '../types/Api';

/** Anyone an issue may be assigned to, from either membership list. */
export type Assignable = Pick<
  MemberRead | TeamMemberRead,
  'user_id' | 'email' | 'display_name' | 'avatar_url'
>;

/** How a person reads, preferring their name and falling back to their email. */
export const personLabel = (person: Assignable | undefined): string =>
  person === undefined ? 'Unknown' : (person.display_name ?? person.email);

/** A person's avatar image, or null when they show their initials. */
export const personAvatar = (person: Assignable | undefined): string | null =>
  person?.avatar_url ?? null;

/** Resolves a person id to their avatar image against the people the page knows about. */
export const avatarOf = (
  userId: string | null,
  people: Assignable[]
): string | null =>
  userId === null
    ? null
    : personAvatar(people.find((person) => person.user_id === userId));

/** Resolves an assignee id against the people the page knows about. */
export const assigneeLabel = (
  assigneeId: string | null,
  people: Assignable[]
): string =>
  assigneeId === null
    ? 'Unassigned'
    : personLabel(people.find((person) => person.user_id === assigneeId));

/** Names an activity entry's actor, which may be the product or an integration. */
export const actorLabel = (
  actorKind: string,
  actorId: string,
  people: Assignable[]
): string => {
  if (actorKind === 'github') return 'GitHub';
  if (actorKind === 'system') return 'Standupless';
  return personLabel(people.find((person) => person.user_id === actorId));
};
