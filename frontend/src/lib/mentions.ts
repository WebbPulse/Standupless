/**
 * The composer's @mention autocomplete and the directory a rendered mention is
 * read against. The server reads a handle as a letter or digit followed by
 * letters, digits, underscores and hyphens, and resolves it against a member's
 * display name with the spaces removed, their email local part, and then any
 * handle they gave up in a rename, so the composer inserts the first of those
 * that fits the handle form, and a mention written under an old handle renders
 * as the person's handle today.
 */

import type { MemberRead } from '../types/Api';
import { isPickable, type Assignable } from './issuePeople';

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
 * The handle a person is mentioned by: their display name without spaces when
 * it fits the handle form, else their email's local part, else the local part
 * with the characters a handle cannot hold dropped.
 */
export const mentionHandle = (person: Assignable): string => {
  const display = (person.display_name ?? '').replace(/\s+/g, '');
  if (HANDLE.test(display)) return display;
  const local = person.email.split('@')[0] ?? person.email;
  if (HANDLE.test(local)) return local;
  return local.replace(/[^A-Za-z0-9_-]/g, '');
};

/** The handles a member answers to now, lowercased, display name first. */
const currentHandles = (member: Assignable): string[] => {
  const display = (member.display_name ?? '').replace(/\s+/g, '').toLowerCase();
  const local = (member.email.split('@')[0] ?? '').trim().toLowerCase();
  return [display, local].filter((handle) => handle !== '');
};

/**
 * Maps every handle that names a member, lowercased, to the handle they are
 * mentioned by today. Current handles are entered before former ones and the
 * first entry wins, the same order the server resolves in, so a former handle
 * never takes over a name somebody holds now.
 */
export const mentionDirectory = (
  members: Pick<
    MemberRead,
    'user_id' | 'email' | 'display_name' | 'previous_handles'
  >[]
): ReadonlyMap<string, string> => {
  const directory = new Map<string, string>();
  for (const member of members) {
    const shown = mentionHandle(member);
    for (const handle of currentHandles(member)) {
      if (!directory.has(handle)) directory.set(handle, shown);
    }
  }
  for (const member of members) {
    const shown = mentionHandle(member);
    for (const handle of member.previous_handles ?? []) {
      const key = handle.toLowerCase();
      if (key !== '' && !directory.has(key)) directory.set(key, shown);
    }
  }
  return directory;
};

/** The people whose name or email matches the query, best matches first. */
export const matchPeople = (
  people: Assignable[],
  query: string
): Assignable[] => {
  const term = query.toLowerCase();
  const scored = people.filter(isPickable).flatMap((person) => {
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
