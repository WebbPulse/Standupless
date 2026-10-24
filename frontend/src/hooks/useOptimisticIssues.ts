/**
 * Optimistic writes over a read of issues. The changed rows are laid over the
 * read at once and stay there until a re-read brings a newer version of the
 * issue, so a row never flickers back to its old value between the write
 * landing and the next poll. A failed write drops its overlay and says so in
 * a toast. A date is written issue by issue, because the bulk route never
 * takes dates. Every landed change is recorded for undo, and an undo lays the
 * old values over the rows the same way until the re-read catches up.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invalidateQueries, type QueryKey } from '@webbpulse/api-client/react';
import {
  BULK_MAX_ISSUES,
  bulkUpdateIssues,
  updateIssue,
  type IssueBulkPatch,
  type OrderedIssueRead,
} from '../api/issues';
import { errorMessage } from '../lib/errors';
import { recordIssueChange } from '../lib/issueUndo';
import { applyChange, changeIsNoop, type IssueChange } from '../lib/issueView';
import { showErrorToast } from '../lib/toast';
import type { IssueRead } from '../types/Api';

/** Writes a change to issues: one for all, or each issue's own, or null. */
export type IssueWrite = (
  ids: readonly string[],
  change: IssueChange | ((issue: OrderedIssueRead) => IssueChange | null)
) => void;

/** What {@link useOptimisticIssues} hands back. */
export interface OptimisticIssues {
  /** The read with every pending and confirmed write laid over it. */
  issues: OrderedIssueRead[];
  update: IssueWrite;
  /** Lays rows written elsewhere, such as by an undo, over the read. */
  layOver: (written: readonly IssueRead[]) => void;
}

/** A row laid over the read, and the version of the row it was laid over. */
interface Overlay {
  issue: OrderedIssueRead;
  since: string;
}

/** The bulk patch a change becomes. A manual position is never bulk written. */
const bulkPatch = (change: IssueChange): IssueBulkPatch => {
  const {
    sort_order: _order,
    start_date: _start,
    due_date: _due,
    ...patch
  } = change;
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
export const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(items.slice(at, at + size));
  }
  return out;
};

/**
 * Lays optimistic writes over `read`, the rows a query answered under
 * `queryKey`, and writes changes to them. The key is refreshed after a write.
 */
export const useOptimisticIssues = (
  workspaceId: string,
  read: readonly OrderedIssueRead[] | undefined,
  queryKey: QueryKey
): OptimisticIssues => {
  const [overlays, setOverlays] = useState<Record<string, Overlay>>({});
  const readRef = useRef<readonly OrderedIssueRead[]>(read ?? []);
  useEffect(() => {
    readRef.current = read ?? [];
  }, [read]);

  const layOver = useCallback((written: readonly IssueRead[]): void => {
    const base = new Map(readRef.current.map((row) => [row.id, row]));
    setOverlays((held) => {
      const next = { ...held };
      for (const issue of written) {
        const row = held[issue.id]?.issue ?? base.get(issue.id);
        if (row === undefined) continue;
        next[issue.id] = {
          since: base.get(issue.id)?.updated_at ?? '',
          issue: { ...row, ...issue, sort_order: row.sort_order ?? null },
        };
      }
      return next;
    });
  }, []);

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

  const update = useCallback<IssueWrite>(
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

      const landed: OrderedIssueRead[] = [];
      const record = (): void => {
        const before = new Map(planned.map(({ issue }) => [issue.id, issue]));
        recordIssueChange(
          workspaceId,
          landed.flatMap((after) => {
            const prior = before.get(after.id);
            return prior === undefined ? [] : [{ before: prior, after }];
          }),
          { invalidate: [queryKey], onReverted: layOver }
        );
      };

      const confirm = (written: OrderedIssueRead[]): void => {
        landed.push(...written);
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

      const oneByOne =
        planned.length === 1 ||
        planned.some(
          ({ change: own }) =>
            own.start_date !== undefined || own.due_date !== undefined
        );
      if (oneByOne) {
        const writes = planned.map(({ issue, change: own }) =>
          updateIssue(workspaceId, issue.id, singlePatch(issue, own)).then(
            (written) => {
              confirm([written]);
            },
            (cause: unknown) => {
              rollback([issue.id], cause);
            }
          )
        );
        void Promise.all(writes).then(() => {
          record();
          invalidateQueries(queryKey);
        });
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
        record();
        invalidateQueries(queryKey);
      });
    },
    [issues, read, workspaceId, queryKey, layOver]
  );

  return { issues, update, layOver };
};
