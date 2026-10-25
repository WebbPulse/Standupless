/**
 * The pieces of a batch of team membership calls: running them a few at a
 * time, summing up the result in one notice, masking the emails a picker
 * shows, and the last team owner guard the bulk bar keeps.
 */

import type { TeamMemberRead } from '../types/Api';

/** How many grant, role or removal calls a batch keeps in flight at once. */
export const BATCH_CONCURRENCY = 4;

/** Why the bulk bar refuses to demote or remove every team owner. */
export const LAST_OWNER_REASON =
  'A team needs at least one owner. Keep one selected owner out of this change.';

/** Hides most of an email's local part, keeping its first letter and domain. */
export const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***${email.slice(at)}`;
};

/**
 * Runs `task` over every item with at most `limit` in flight, settling each
 * one, and answers the ids whose task failed in the order given.
 */
export const runBounded = async (
  ids: string[],
  limit: number,
  task: (id: string) => Promise<unknown>
): Promise<string[]> => {
  const failed = new Set<string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ids.length) {
      const id = ids[next];
      next += 1;
      if (id === undefined) continue;
      try {
        await task(id);
      } catch {
        failed.add(id);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, ids.length) }, () => worker())
  );
  return ids.filter((id) => failed.has(id));
};

/** The notice that sums up a batch, such as "Added 5, 1 failed". */
export const batchSummary = (
  verb: string,
  total: number,
  failed: number
): string => {
  const done = total - failed;
  if (failed === 0) return `${verb} ${String(done)}`;
  if (done === 0) return `${String(failed)} failed`;
  return `${verb} ${String(done)}, ${String(failed)} failed`;
};

/**
 * Whether a bulk demotion or removal of `selected` would leave the team with
 * no owner. A team with no owner today is left to the server.
 */
export const removesLastOwner = (
  members: TeamMemberRead[],
  selected: Set<string>
): boolean => {
  const owners = members.filter((member) => member.role === 'admin');
  return (
    owners.length > 0 && owners.every((member) => selected.has(member.user_id))
  );
};
