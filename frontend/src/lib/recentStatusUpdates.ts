/**
 * Which updates on a project or initiative are recent enough that someone about
 * to post should read them first. The newest update sets the health, so two
 * authors posting the same due update overwrite each other in silence.
 *
 * The window matches the one the server uses when it answers a create with the
 * updates posted around it, and the check is a plain comparison of post times.
 */

import type { ProjectHealth } from '../types/Api';
import { PROJECT_HEALTH_LABELS } from './planningDisplay';
import { relativeTime } from './relativeTime';

/** How close to now an update counts as just posted. */
export const RECENT_UPDATE_WINDOW_MS = 5 * 60 * 1000;

/** The updates posted inside the window ending at `now`, in the order given. */
export const recentUpdatesOf = <T extends { created_at: string }>(
  updates: T[],
  now: number
): T[] =>
  updates.filter(
    (update) =>
      now - new Date(update.created_at).getTime() < RECENT_UPDATE_WINDOW_MS
  );

/** One sentence naming a recent update: who, how long ago and the health it called. */
export const recentUpdateLine = (
  author: string,
  update: { created_at: string; health: ProjectHealth },
  now: number
): string =>
  `${author} posted an update ${relativeTime(update.created_at, new Date(now))}, health ${PROJECT_HEALTH_LABELS[update.health]}.`;
