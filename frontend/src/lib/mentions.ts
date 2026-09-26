/**
 * The composer's @mention autocomplete. The server reads a handle as a letter
 * or digit followed by letters, digits, underscores and hyphens, and resolves
 * it against a member's email local part or their display name with the spaces
 * removed, so the composer inserts whichever of those fits the handle form.
 */

import type { Assignable } from './issuePeople';

/** The mention being typed: where its `@` sits and what follows it. */
export interface MentionQuery {
  start: number;
  query: string;
}

/** How many people the autocomplete offers at once. */
export const MENTION_LIMIT = 6;

/**
 * The mention the caret is in, or null. The `@` must start the text or follow
 * whitespace, so an email address being typed does not open the list.
 */
export const mentionQuery = (
  text: string,
  caret: number
): MentionQuery | null => {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w-]*)$/.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
};

/** The shape the server reads a handle in. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/;

/**
 * The handle a person is mentioned by: their email's local part when it fits
 * the handle form, else their display name without spaces, else the local
 * part with the characters a handle cannot hold dropped.
 */
export const mentionHandle = (person: Assignable): string => {
  const local = person.email.split('@')[0] ?? person.email;
  if (HANDLE.test(local)) return local;
  const display = (person.display_name ?? '').replace(/\s+/g, '');
  if (HANDLE.test(display)) return display;
  return local.replace(/[^A-Za-z0-9_-]/g, '');
};

/** The people whose name or email matches the query, best matches first. */
export const matchPeople = (
  people: Assignable[],
  query: string
): Assignable[] => {
  const term = query.toLowerCase();
  const scored = people.flatMap((person) => {
    const name = (person.display_name ?? '').toLowerCase();
    const handle = mentionHandle(person).toLowerCase();
    if (term === '') return [{ person, score: 1 }];
    if (handle.startsWith(term) || name.startsWith(term)) {
      return [{ person, score: 0 }];
    }
    if (
      handle.includes(term) ||
      name.includes(term) ||
      person.email.toLowerCase().includes(term)
    ) {
      return [{ person, score: 1 }];
    }
    return [];
  });
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, MENTION_LIMIT)
    .map((row) => row.person);
};

/** The text with the mention at `query` replaced by the person's handle. */
export const insertMention = (
  text: string,
  query: MentionQuery,
  person: Assignable
): { text: string; caret: number } => {
  const end = query.start + 1 + query.query.length;
  const inserted = `@${mentionHandle(person)} `;
  return {
    text: `${text.slice(0, query.start)}${inserted}${text.slice(end)}`,
    caret: query.start + inserted.length,
  };
};
