/**
 * The rows an issue list or board is drawn from, and the one way they are
 * written. Reading pages through the list route up to a ceiling, because a
 * grouped view has to see every row to count and place them, and a board
 * column that stopped at the first page would hide cards without saying so.
 *
 * Writes are optimistic. The changed rows are laid over the read at once and
 * stay there until the list re-reads a newer version of the issue, so a row
 * never flickers back to its old value between the write landing and the
 * next poll. A failed write drops its overlay and says so in a toast.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  BULK_MAX_ISSUES,
  bulkUpdateIssues,
  listIssues,
  updateIssue,
  type IssueBulkPatch,
  type IssueListFilters,
  type OrderedIssueRead,
} from '../api/issues';
import { errorMessage } from '../lib/errors';
import { applyChange, changeIsNoop, type IssueChange } from '../lib/issueView';
import { showErrorToast } from '../lib/toast';

/** How many rows one page reads, the list route's cap. */
export const PAGE_SIZE = 100;

/** How many rows a view reads before it stops and says it is partial. */
export const COLLECTION_LIMIT = 500;

/** How often the rows are re-read. */
const POLL_MS = 30000;

/** One page run of the list route, with whether it stopped at the ceiling. */
interface CollectionRead {
  issues: OrderedIssueRead[];
  truncated: boolean;
}

/** A row laid over the read, and the version of the row it was laid over. */
interface Overlay {
  issue: OrderedIssueRead;
  since: string;
}

/** What {@link useIssueCollection} hands back. */
export interface IssueCollection {
  /** The rows with every pending and confirmed write applied. */
  issues: OrderedIssueRead[];
  isLoading: boolean;
  error: unknown;
  /** True when more rows matched than the view reads. */
  truncated: boolean;
  /** The key the rows are read under, for a caller that wants to refresh them. */
  queryKey: readonly string[];
  /**
   * Writes a change to the given issues. `change` is one change for all of
   * them, or a function answering each issue's own change, or null to leave
   * that issue alone.
   */
  update: (
    ids: readonly string[],
    change: IssueChange | ((issue: OrderedIssueRead) => IssueChange | null)
  ) => void;
}

/** Reads every page of a query up to the ceiling. */
const readAll = async (
  workspaceId: string,
  query: IssueListFilters,
  signal: AbortSignal
): Promise<CollectionRead> => {
  const issues: OrderedIssueRead[] = [];
  let cursor: string | null = null;
  do {
    const page = await listIssues(
      workspaceId,
      {
        ...query,
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
      signal
    );
    issues.push(...page.issues);
    cursor = page.next_cursor;
  } while (cursor !== null && issues.length < COLLECTION_LIMIT);
  return { issues, truncated: cursor !== null };
};

/** The bulk patch a change becomes. A manual position is never bulk written. */
const bulkPatch = (change: IssueChange): IssueBulkPatch => {
  const { sort_order: _ignored, ...patch } = change;
  return patch;
};

/** The single issue patch a change becomes, with the full label list. */
const singlePatch = (
  issue: OrderedIssueRead,
  change: IssueChange
): Record<string, unknown> => {
  const { add_label_ids, remove_label_ids, ...fields } = change;
  return add_label_ids === undefined && remove_label_ids === undefined
    ? fields
    : { ...fields, label_ids: applyChange(issue, change).label_ids };
};

/** Splits a list into runs of at most `size`. */
const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
};

/**
 * Reads the issues a query matches and writes changes to them optimistically.
 * `scope` names what the rows belong to, such as a team or a view, and is
 * part of the read's key.
 */
export const useIssueCollection = (
  workspaceId: string,
  scope: string,
  query: IssueListFilters,
  enabled = true
): IssueCollection => {
  const auth = useQueryAuth();
  const queryJson = JSON.stringify(query);
  const queryKey = useMemo(
    () => ['issue-collection', workspaceId, scope, queryJson] as const,
    [workspaceId, scope, queryJson]
  );
  const [overlays, setOverlays] = useState<Record<string, Overlay>>({});

  const { data, isLoading, error } = usePolledQuery(
    ({ signal }) =>
      readAll(workspaceId, JSON.parse(queryJson) as IssueListFilters, signal),
    {
      intervalMs: POLL_MS,
      enabled: enabled && workspaceId !== '',
      queryKey,
      auth,
    }
  );

  const read = data?.issues;
  const issues = useMemo(
    () =>
      (read ?? []).map((issue) => {
        const overlay = overlays[issue.id];
        return overlay !== undefined && overlay.since === issue.updated_at
          ? overlay.issue
          : issue;
      }),
    [read, overlays]
  );

  const update = useCallback<IssueCollection['update']>(
    (ids, change) => {
      const byId = new Map(issues.map((issue) => [issue.id, issue]));
      const baseById = new Map((read ?? []).map((issue) => [issue.id, issue]));
      const planned: { issue: OrderedIssueRead; change: IssueChange }[] = [];
      for (const id of ids) {
        const issue = byId.get(id);
        if (issue === undefined) continue;
        const own = typeof change === 'function' ? change(issue) : change;
        if (own === null || changeIsNoop(issue, own)) continue;
        planned.push({ issue, change: own });
      }
      if (planned.length === 0) return;

      const sinceOf = (id: string): string =>
        baseById.get(id)?.updated_at ?? '';

      setOverlays((held) => {
        const next = { ...held };
        for (const { issue, change: own } of planned) {
          next[issue.id] = {
            issue: applyChange(issue, own),
            since: sinceOf(issue.id),
          };
        }
        return next;
      });

      const rollback = (failed: string[], cause: unknown): void => {
        setOverlays((held) => {
          const next = { ...held };
          for (const id of failed) delete next[id];
          return next;
        });
        showErrorToast(
          errorMessage(
            cause,
            failed.length === 1
              ? 'Could not update that issue.'
              : `Could not update ${String(failed.length)} issues.`
          )
        );
        invalidateQueries(queryKey);
      };

      const confirm = (written: OrderedIssueRead[]): void => {
        setOverlays((held) => {
          const next = { ...held };
          for (const issue of written) {
            const overlay = next[issue.id];
            if (overlay === undefined) continue;
            next[issue.id] = {
              since: overlay.since,
              issue: {
                ...overlay.issue,
                ...issue,
                sort_order:
                  issue.sort_order ?? overlay.issue.sort_order ?? null,
              },
            };
          }
          return next;
        });
      };

      const single = planned.length === 1 ? planned[0] : undefined;
      if (single !== undefined) {
        updateIssue(
          workspaceId,
          single.issue.id,
          singlePatch(single.issue, single.change)
        ).then(
          (written) => {
            confirm([written]);
            invalidateQueries(queryKey);
          },
          (cause: unknown) => {
            rollback([single.issue.id], cause);
          }
        );
        return;
      }

      const batches = new Map<
        string,
        { patch: IssueBulkPatch; ids: string[] }
      >();
      for (const { issue, change: own } of planned) {
        const patch = bulkPatch(own);
        const slot = JSON.stringify(patch);
        const batch = batches.get(slot) ?? { patch, ids: [] };
        batch.ids.push(issue.id);
        batches.set(slot, batch);
      }
      const writes = [...batches.values()].flatMap((batch) =>
        chunks(batch.ids, BULK_MAX_ISSUES).map((part) =>
          bulkUpdateIssues(workspaceId, {
            issue_ids: part,
            patch: batch.patch,
          }).then(
            (answer) => {
              confirm(answer.issues);
            },
            (cause: unknown) => {
              rollback(part, cause);
            }
          )
        )
      );
      void Promise.all(writes).then(() => {
        invalidateQueries(queryKey);
      });
    },
    [issues, read, workspaceId, queryKey]
  );

  return {
    issues,
    isLoading,
    error,
    truncated: data?.truncated ?? false,
    queryKey,
    update,
  };
};

export default useIssueCollection;
