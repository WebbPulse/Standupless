/**
 * Every release the reader can see with the issues it carries, so a list
 * groups an issue under each release that shipped it and labels its row.
 */

import { useCallback, useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listReleaseIndex } from '../api/releases';
import { releaseIndexKey } from '../lib/queryKeys';
import type { IssueContext, IssueRelease } from '../lib/issueView';
import type { ReleaseIndexEntryRead } from '../types/Api';

/** How often the releases re-read. */
const POLL_MS = 60000;

/** What {@link useReleaseIndex} hands back. */
export interface ReleaseIndex {
  /** The releases, as a list groups and filters by them, until read undefined. */
  releases: IssueRelease[] | undefined;
  /** The release ids carrying each issue, by issue id. */
  byIssue: ReadonlyMap<string, readonly string[]>;
  isLoading: boolean;
}

/** The release ids naming each issue, from the release index. */
export const releasesByIssue = (
  entries: readonly ReleaseIndexEntryRead[]
): Map<string, string[]> => {
  const byIssue = new Map<string, string[]>();
  for (const entry of entries) {
    for (const issueId of entry.issue_ids) {
      const held = byIssue.get(issueId) ?? [];
      if (!held.includes(entry.release_id)) held.push(entry.release_id);
      byIssue.set(issueId, held);
    }
  }
  return byIssue;
};

/** A release index entry as a list groups and labels by it. */
export const issueReleaseOf = (entry: ReleaseIndexEntryRead): IssueRelease => ({
  id: entry.release_id,
  name: entry.name,
  teamId: entry.team_id,
  stagePosition: entry.stage_position,
  createdAt: entry.created_at,
  ...(entry.current_stage == null
    ? {}
    : { stageName: entry.current_stage.name }),
});

/**
 * The part of an issue list's context a release index fills: nothing until
 * it is read, so a list offers release grouping and filtering only then.
 */
export const releaseContext = (
  index: Pick<ReleaseIndex, 'releases' | 'byIssue'>
): Pick<IssueContext, 'releases' | 'issueReleases'> =>
  index.releases === undefined
    ? {}
    : { releases: index.releases, issueReleases: index.byIssue };

/** Reads the workspace's release index while `enabled` holds. */
export const useReleaseIndex = (
  workspaceId: string,
  enabled: boolean
): ReleaseIndex => {
  const auth = useQueryAuth();

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      listReleaseIndex(workspaceId, signal),
    [workspaceId]
  );

  const { data, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: enabled && workspaceId !== '',
    queryKey: releaseIndexKey(workspaceId),
    auth,
  });

  const entries = useMemo(() => data?.releases ?? [], [data]);
  const releases = useMemo(
    () => (data === undefined ? undefined : entries.map(issueReleaseOf)),
    [data, entries]
  );
  const byIssue = useMemo(() => releasesByIssue(entries), [entries]);

  return useMemo(
    () => ({ releases, byIssue, isLoading }),
    [releases, byIssue, isLoading]
  );
};

export default useReleaseIndex;
