/**
 * A one-off list of the issues named by comma-separated keys in the address,
 * such as `/w/:slug/issues/ENG-1,WEB-7,ENG-3`, as Linear opens one. The keys
 * may span teams and are read in one request through the list route's `key`
 * parameter, so the rows keep everything a list has: selection, bulk actions,
 * peek, j and k, and the display options. Rows open in the order the keys name
 * them, a key that names nothing the caller can read is skipped with a quiet
 * count, and Save as view keeps a view over the issue ids the keys resolved to.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { IssueListFilters, OrderedIssueRead } from '../../api/issues';
import IssueViewPage from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { defaultViewState, type ViewState } from '../../lib/issueView';

/** The most keys one list reads, the list route's own ceiling. */
export const KEY_LIST_MAX = 100;

/**
 * The keys a `:key` route segment names: split on commas, trimmed, upper-cased
 * and each kept once in the order first named, up to {@link KEY_LIST_MAX}.
 * More than one key makes the segment a list rather than one issue.
 */
export const parseIssueKeys = (segment: string): string[] => {
  const keys: string[] = [];
  for (const part of segment.split(',')) {
    const key = part.trim().toUpperCase();
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys.slice(0, KEY_LIST_MAX);
};

/** The settings the list opens with: one ungrouped list in the order named. */
export const keyListBase = (): ViewState => ({
  ...defaultViewState('list'),
  groupBy: 'none',
  ordering: 'manual',
});

/** The quiet line naming how many keys were skipped, or null when none were. */
export const notFoundNote = (missing: number): string | null =>
  missing <= 0
    ? null
    : missing === 1
      ? '1 key was not found.'
      : `${missing} keys were not found.`;

/** What the list says when no key names an issue the caller can read. */
export const EMPTY_MESSAGE = 'None of these keys name an issue you can see.';

/**
 * An id no issue holds, saved when no key resolved, so the view lists nothing
 * rather than everything.
 */
const UNMATCHED_ISSUE_ID = '-';

/**
 * What the page has learned from its reads: each issue's id by its current
 * key, and whether a read has settled, so the skipped count waits for one.
 */
interface Seen {
  ids: ReadonlyMap<string, string>;
  settled: boolean;
}

/** The list for the given keys. */
export const IssueKeyList: React.FC<{ keys: string[] }> = ({ keys }) => {
  const { workspace } = useWorkspace();
  const { teams, isLoading, error } = useTeam(undefined);
  const [seen, setSeen] = useState<Seen>({ ids: new Map(), settled: false });
  const joined = keys.join(',');
  const scope = useMemo<IssueListFilters>(
    () => ({ key: joined.split(',') }),
    [joined]
  );
  const base = useMemo(keyListBase, []);

  const onRowsRead = useCallback((issues: readonly OrderedIssueRead[]) => {
    setSeen((current) => {
      const fresh = issues.filter(
        (issue) => current.ids.get(issue.key.toUpperCase()) !== issue.id
      );
      if (fresh.length === 0 && current.settled) return current;
      const ids = new Map(current.ids);
      for (const issue of fresh) ids.set(issue.key.toUpperCase(), issue.id);
      return { ids, settled: true };
    });
  }, []);

  const rank = useMemo(() => {
    const positions = new Map<string, number>();
    keys.forEach((key, index) => {
      const id = seen.ids.get(key);
      if (id !== undefined && !positions.has(id)) positions.set(id, index);
    });
    return positions;
  }, [keys, seen]);

  const ids = useMemo(() => [...new Set(seen.ids.values())], [seen]);
  const title = keys.length === 1 ? '1 issue' : `${keys.length} issues`;

  if (workspace === null || teams.length === 0) {
    return (
      <WorkspaceShell title={title} flush>
        {error !== null && error !== undefined ? (
          <div className="px-4 pt-3 lg:px-6">
            <ErrorAlert
              message={errorMessage(error, 'Could not load your teams.')}
            />
          </div>
        ) : isLoading || workspace === null ? (
          <SkeletonRows label="Loading issues" />
        ) : (
          <EmptyState message={EMPTY_MESSAGE} />
        )}
      </WorkspaceShell>
    );
  }

  const note = seen.settled ? notFoundNote(keys.length - ids.length) : null;
  const canEdit = teams.some((team) =>
    canWriteIssues(workspace.role, team.role)
  );

  return (
    <IssueViewPage
      key={joined}
      workspaceId={workspace.id}
      slug={workspace.slug}
      title={title}
      scopeKey={`keys-${joined}`}
      scope={scope}
      teams={teams}
      base={base}
      canEdit={canEdit}
      homeTeam={teams.length === 1 ? teams[0] : undefined}
      emptyMessage={EMPTY_MESSAGE}
      rank={rank}
      saveScope={{ issue_id: ids.length > 0 ? ids : [UNMATCHED_ISSUE_ID] }}
      onRowsRead={onRowsRead}
      notice={
        note === null ? undefined : (
          <p className="text-sm text-text-muted" role="status">
            {note}
          </p>
        )
      }
    />
  );
};

export default IssueKeyList;
