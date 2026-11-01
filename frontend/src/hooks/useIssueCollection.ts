/**
 * The rows an issue list or board is drawn from, and the one way they are
 * written. Reading pages through the list route up to a ceiling, because a
 * grouped view has to see every row to count and place them, and a board
 * column that stopped at the first page would hide cards without saying so.
 *
 * Only the first read, and a resync every few minutes, reads every page.
 * Between them a poll asks the list route for what changed since its cursor
 * and folds that into the rows held, which is most of the list's read cost
 * saved on a quiet workspace. Each delta sends back the ETag of the last one,
 * so a poll that finds nothing is a bodiless 304. The server asks for a full
 * read when a delta cannot be trusted, and a failed delta falls back to one.
 *
 * Writes are optimistic, through useOptimisticIssues. The changed rows are
 * laid over the read at once and stay there until the list re-reads a newer
 * version of the issue, so a row never flickers back to its old value between
 * the write landing and the next poll. A failed write drops its overlay and says so in a toast. A date
 * is written issue by issue, because the bulk route never takes dates.
 * Deleting hides the rows at once and puts back any the server refuses.
 * Archiving goes through the bulk route and does the same when the view
 * leaves archived issues out, as restoring does in the archive view. Every
 * landed change and archive is recorded for undo, and an undo lays the old
 * values over the rows the same way until the re-read catches up.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  BULK_MAX_ISSUES,
  bulkUpdateIssues,
  deleteIssue,
  listIssueDelta,
  listIssues,
  type IssueListFilters,
  type OrderedIssueRead,
} from '../api/issues';
import { errorMessage } from '../lib/errors';
import { mergeIssueDelta } from '../lib/issueDelta';
import { useRealtimePollMs } from '../lib/polling';
import { useLiveQueryKey } from '../lib/realtime';
import { recordArchive, recordDelete } from '../lib/issueUndo';
import { showErrorToast } from '../lib/toast';
import {
  chunks,
  useOptimisticIssues,
  type IssueWrite,
} from './useOptimisticIssues';

/** How many rows one page reads, the list route's cap. */
export const PAGE_SIZE = 100;

/** How many rows a view reads before it stops and says it is partial. */
export const COLLECTION_LIMIT = 500;

/** How often the rows are re-read. */
const POLL_MS = 30000;

/** How long deltas run before the rows are read in full again, as a safety net. */
export const RESYNC_MS = 10 * 60 * 1000;

/** One page run of the list route, with whether it stopped at the ceiling. */
interface CollectionRead {
  issues: OrderedIssueRead[];
  truncated: boolean;
  /** The cursor the next delta sends, or null when the server gave none. */
  syncedAt: string | null;
  /** When the rows were last read in full, in epoch milliseconds. */
  fullAt: number;
  /** The ETag of the last delta answered for `syncedAt`, sent back next poll. */
  etag: string | undefined;
}

/** The rows a delta builds on, and the query they were read for. */
interface HeldRead {
  key: string;
  read: CollectionRead;
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
  update: IssueWrite;
  /** Deletes the given issues, hiding them until the server answers. */
  remove?: (ids: readonly string[]) => Promise<void>;
  /**
   * Archives the given issues, or restores them with `restore`. Archived rows
   * leave a view that does not list archived issues at once.
   */
  archive?: (ids: readonly string[], restore?: boolean) => Promise<void>;
  /** True when the rows are the archive alone, so a restore hides them. */
  archivedOnly?: boolean;
}

/** Reads every page of a query up to the ceiling. */
const readAll = async (
  workspaceId: string,
  query: IssueListFilters,
  signal: AbortSignal
): Promise<CollectionRead> => {
  const issues: OrderedIssueRead[] = [];
  let cursor: string | null = null;
  let syncedAt: string | null = null;
  let first = true;
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
    if (first) syncedAt = page.synced_at ?? null;
    first = false;
    cursor = page.next_cursor;
  } while (cursor !== null && issues.length < COLLECTION_LIMIT);
  return {
    issues,
    truncated: cursor !== null,
    syncedAt,
    fullAt: Date.now(),
    etag: undefined,
  };
};

/**
 * Folds what changed since `held` into it, or answers null when the server
 * asks for a full read. An unchanged answer, a 304 included, hands back `held`
 * itself, so a quiet poll renders nothing.
 */
const readDelta = async (
  workspaceId: string,
  query: IssueListFilters,
  held: CollectionRead,
  since: string,
  signal: AbortSignal
): Promise<CollectionRead | null> => {
  const { page, etag } = await listIssueDelta(
    workspaceId,
    { ...query, updated_since: since },
    held.etag,
    signal
  );
  if (page === null) return held;
  if (page.resync_required === true) return null;
  const removedIds = page.removed_ids ?? [];
  const syncedAt = page.synced_at ?? since;
  if (page.issues.length === 0 && removedIds.length === 0) {
    return syncedAt === held.syncedAt && etag === held.etag
      ? held
      : { ...held, syncedAt, etag };
  }
  return {
    ...held,
    syncedAt,
    etag,
    issues: mergeIssueDelta(
      held.issues,
      { issues: page.issues, removedIds },
      query.sort ?? 'updated_desc',
      held.truncated ? COLLECTION_LIMIT : undefined,
      {
        reverse: query.reverse === true,
        completedByRecency: query.completed_by_recency === true,
      }
    ),
  };
};

/**
 * One poll: a delta over the rows held when they are fresh enough and read
 * for the same query, otherwise every page.
 */
const readCollection = async (
  workspaceId: string,
  query: IssueListFilters,
  held: CollectionRead | null,
  signal: AbortSignal
): Promise<CollectionRead> => {
  const syncedAt = held?.syncedAt ?? null;
  if (
    held !== null &&
    syncedAt !== null &&
    Date.now() - held.fullAt < RESYNC_MS
  ) {
    try {
      const next = await readDelta(workspaceId, query, held, syncedAt, signal);
      if (next !== null) return next;
    } catch (cause) {
      if (signal.aborted) throw cause;
    }
  }
  return readAll(workspaceId, query, signal);
};

/** How {@link useIssueCollection} behaves beyond its query. */
export interface IssueCollectionOptions {
  /**
   * Keeps showing the last rows read while a changed query reads, rather than
   * dropping back to loading, for a list whose query grows as it pages.
   */
  holdRows?: boolean;
}

/**
 * Reads the issues a query matches and writes changes to them optimistically.
 * `scope` names what the rows belong to, such as a team or a view, and is
 * part of the read's key.
 */
export const useIssueCollection = (
  workspaceId: string,
  scope: string,
  query: IssueListFilters,
  enabled = true,
  options: IssueCollectionOptions = {}
): IssueCollection => {
  const auth = useQueryAuth();
  const queryJson = JSON.stringify(query);
  const queryKey = useMemo(
    () => ['issue-collection', workspaceId, scope, queryJson] as const,
    [workspaceId, scope, queryJson]
  );
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const heldRef = useRef<HeldRead | null>(null);
  const intervalMs = useRealtimePollMs(POLL_MS);
  useLiveQueryKey(queryKey, enabled && workspaceId !== '');

  const { data, isLoading, error } = usePolledQuery(
    async ({ signal }) => {
      const key = JSON.stringify(queryKey);
      const held = heldRef.current?.key === key ? heldRef.current.read : null;
      const read = await readCollection(
        workspaceId,
        JSON.parse(queryJson) as IssueListFilters,
        held,
        signal
      );
      heldRef.current = { key, read };
      return read;
    },
    {
      intervalMs,
      enabled: enabled && workspaceId !== '',
      queryKey,
      auth,
    }
  );

  const [last, setLast] = useState<CollectionRead | null | undefined>(data);
  if (data !== undefined && data !== null && data !== last) setLast(data);
  const shown = data ?? (options.holdRows === true ? last : undefined);
  const read = shown?.issues;
  const {
    issues: overlaid,
    update,
    layOver,
  } = useOptimisticIssues(workspaceId, read, queryKey);
  const issues = useMemo(
    () => overlaid.filter((issue) => !hidden.has(issue.id)),
    [overlaid, hidden]
  );

  const remove = useCallback(
    async (ids: readonly string[]): Promise<void> => {
      const targets = [...new Set(ids)];
      if (targets.length === 0) return;
      setHidden((held) => new Set([...held, ...targets]));
      const results = await Promise.allSettled(
        targets.map((id) => deleteIssue(workspaceId, id))
      );
      const failed = targets.filter(
        (_id, index) => results[index]?.status === 'rejected'
      );
      const deleted = targets.length - failed.length;
      if (failed.length > 0) {
        setHidden((held) => {
          const next = new Set(held);
          for (const id of failed) next.delete(id);
          return next;
        });
        const first = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        );
        showErrorToast(
          errorMessage(
            first?.reason,
            failed.length === 1
              ? 'Could not delete that issue.'
              : `Could not delete ${String(failed.length)} issues.`
          )
        );
      }
      if (deleted > 0) {
        const byId = new Map(issues.map((issue) => [issue.id, issue]));
        const gone = targets.filter((id) => !failed.includes(id));
        recordDelete(
          workspaceId,
          gone.map((id) => ({ id, key: byId.get(id)?.key ?? 'issue' })),
          {
            invalidate: [queryKey],
            onReverted: (written) => {
              setHidden((held) => {
                const next = new Set(held);
                for (const id of gone) next.delete(id);
                return next;
              });
              layOver(written);
            },
          }
        );
      }
      invalidateQueries(queryKey);
    },
    [workspaceId, queryKey, issues, layOver]
  );

  const archivedOnly = query.archived_only === true;
  const listsArchived = query.include_archived === true;
  const archive = useCallback(
    async (ids: readonly string[], restore = false): Promise<void> => {
      const targets = [...new Set(ids)];
      if (targets.length === 0) return;
      const hides = archivedOnly ? restore : !restore && !listsArchived;
      if (hides) setHidden((held) => new Set([...held, ...targets]));
      const parts = chunks(targets, BULK_MAX_ISSUES);
      const results = await Promise.allSettled(
        parts.map((part) =>
          bulkUpdateIssues(workspaceId, {
            issue_ids: part,
            patch: { archived: !restore },
          })
        )
      );
      const failed = parts.flatMap((part, index) =>
        results[index]?.status === 'rejected' ? part : []
      );
      const done = targets.length - failed.length;
      if (failed.length > 0) {
        if (hides) {
          setHidden((held) => {
            const next = new Set(held);
            for (const id of failed) next.delete(id);
            return next;
          });
        }
        const first = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        );
        const verb = restore ? 'restore' : 'archive';
        showErrorToast(
          errorMessage(
            first?.reason,
            failed.length === 1
              ? `Could not ${verb} that issue.`
              : `Could not ${verb} ${String(failed.length)} issues.`
          )
        );
      }
      if (done > 0) {
        const byId = new Map(issues.map((issue) => [issue.id, issue]));
        const unhide = (): void => {
          if (!hides) return;
          setHidden((held) => {
            const next = new Set(held);
            for (const id of targets) next.delete(id);
            return next;
          });
        };
        recordArchive(
          workspaceId,
          targets
            .filter((id) => !failed.includes(id))
            .map((id) => ({ id, key: byId.get(id)?.key ?? 'issue' })),
          restore,
          {
            invalidate: [queryKey],
            onReverted: (written) => {
              unhide();
              layOver(written);
            },
          }
        );
      }
      invalidateQueries(queryKey);
    },
    [workspaceId, queryKey, listsArchived, archivedOnly, issues, layOver]
  );

  return {
    issues,
    isLoading: isLoading && shown === undefined,
    error,
    truncated: shown?.truncated ?? false,
    queryKey,
    update,
    remove,
    archive,
    archivedOnly,
  };
};

export default useIssueCollection;
