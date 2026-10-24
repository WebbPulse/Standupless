/**
 * Shared pieces of syncing a comment thread to GitHub: how a target is keyed
 * and the warning a public repository carries, so the composer and a thread's
 * menu say the same thing.
 */

import type { GithubThread, GithubThreadTargetRead } from '../types/Api';

/** The key one sync target is chosen and matched by. */
export const targetKey = (
  target: Pick<GithubThreadTargetRead, 'repository_id' | 'number'>
): string => `${target.repository_id}#${String(target.number)}`;

/** The warning shown before a thread is published on a public repository. */
export const PUBLIC_THREAD_WARNING =
  'Public repository: anyone can read this thread on GitHub.';

/** How a synced thread names its target, such as `owner/repo#7`. */
export const threadRef = (thread: GithubThread): string =>
  `${thread.full_name}#${String(thread.number)}`;

/** Where a synced thread's badge links: the mirrored comment once it lands. */
export const threadUrl = (thread: GithubThread): string =>
  thread.comment_url !== '' ? thread.comment_url : thread.target_url;
