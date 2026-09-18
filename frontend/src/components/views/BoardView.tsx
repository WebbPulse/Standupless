/**
 * One project's board: a column per status, each capped by the board read and
 * paged on its own route past that cap. Moving a card writes the issue's
 * status through the M2 issue route rather than a board route, so there stays
 * exactly one write path onto an issue and one place activity is recorded.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  useMutationWithRefetch,
  usePolledQuery,
} from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { updateIssue } from '../../api/issues';
import { getBoard, listBoardColumn } from '../../api/views';
import { errorMessage } from '../../lib/errors';
import { PRIORITY_LABELS } from '../../lib/issueDisplay';
import { assigneeLabel, type Assignable } from '../../lib/issuePeople';
import { boardKey, type BoardKeyFilters } from '../../lib/queryKeys';
import type { BoardColumnRead, IssueRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Spinner from '../ui/spinner';
import { SelectField } from '../ui/select';

/** Props for BoardView: which project, who may move a card, and the lists. */
export interface BoardViewProps {
  workspaceId: string;
  projectId: string;
  /** The workspace slug, so a card links to the issue page. */
  slug: string;
  filters: BoardKeyFilters;
  people: Assignable[];
  canEdit: boolean;
}

/** How many issues the board asks for per column before paging is needed. */
const COLUMN_LIMIT = 25;

/** How often the board is re-read, since a column goes stale as others work. */
const POLL_MS = 30000;

/** The extra pages a person loaded past the board's own cap, per column. */
type Extra = Record<string, { rows: IssueRead[]; cursor: string | null }>;

/** Reads one project's board and moves cards between its columns. */
export const BoardView: React.FC<BoardViewProps> = ({
  workspaceId,
  projectId,
  slug,
  filters,
  people,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const [extra, setExtra] = useState<Extra>({});
  const [paging, setPaging] = useState<string | null>(null);
  const queryKey = boardKey(workspaceId, projectId, filters);

  const enabled = workspaceId !== '' && projectId !== '';

  const query = useMemo(
    () => ({
      ...(filters.assigneeId === '' ? {} : { assignee_id: filters.assigneeId }),
      ...(filters.labelId === '' ? {} : { label_id: filters.labelId }),
      ...(filters.priority === ''
        ? {}
        : { priority: filters.priority as IssueRead['priority'] }),
      column_limit: COLUMN_LIMIT,
    }),
    [filters.assigneeId, filters.labelId, filters.priority]
  );

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getBoard(workspaceId, projectId, query, signal),
    { intervalMs: POLL_MS, enabled, queryKey, auth }
  );

  const { mutate: move, error: moveError } = useMutationWithRefetch(
    (issueId: string, statusId: string) =>
      updateIssue(workspaceId, issueId, { status_id: statusId }),
    queryKey
  );

  const loadColumn = useCallback(
    (column: BoardColumnRead): void => {
      const held = extra[column.status_id];
      const cursor = held === undefined ? column.next_cursor : held.cursor;
      if (cursor === null) return;
      setPaging(column.status_id);
      listBoardColumn(workspaceId, column.status_id, projectId, {
        ...query,
        cursor,
        limit: COLUMN_LIMIT,
      })
        .then((page) => {
          setExtra((current) => {
            const previous = current[column.status_id]?.rows ?? [];
            const seen = new Set(previous.map((row) => row.id));
            return {
              ...current,
              [column.status_id]: {
                rows: [
                  ...previous,
                  ...page.issues.filter((row) => !seen.has(row.id)),
                ],
                cursor: page.next_cursor,
              },
            };
          });
        })
        .catch(() => undefined)
        .finally(() => {
          setPaging(null);
        });
    },
    [workspaceId, projectId, extra, query]
  );

  const columns = data?.columns ?? [];

  if (isLoading) return <Spinner label="Loading board" />;

  return (
    <div className="space-y-3">
      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the board.')}
        />
      )}
      {moveError !== null && (
        <ErrorAlert
          message={errorMessage(moveError, 'Could not move that issue.')}
        />
      )}

      {columns.length === 0 ? (
        <p className="text-sm text-slate-400">
          This project has no statuses yet.
        </p>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {columns.map((column) => {
            const held = extra[column.status_id];
            const rows = [...column.issues, ...(held?.rows ?? [])];
            const cursor =
              held === undefined ? column.next_cursor : held.cursor;
            return (
              <section
                key={column.status_id}
                aria-label={column.name}
                className="w-64 shrink-0 space-y-2 rounded-md border border-slate-700 p-3"
              >
                <header className="flex items-baseline justify-between gap-2">
                  <h4 className="text-sm font-medium text-white">
                    {column.name}
                  </h4>
                  <span className="text-xs text-slate-500">
                    {column.total}
                  </span>
                </header>

                <ul className="space-y-2">
                  {rows.map((issue) => (
                    <li
                      key={issue.id}
                      className="space-y-1 rounded-md border border-slate-700 bg-slate-800 p-2"
                    >
                      <Link
                        to={`/w/${slug}/issues/${issue.key}`}
                        className="block text-sm text-slate-100 hover:text-white"
                      >
                        <span className="font-mono text-xs text-sky-400">
                          {issue.key}
                        </span>{' '}
                        {issue.title}
                      </Link>
                      <p className="text-xs text-slate-500">
                        {assigneeLabel(issue.assignee_id, people)}
                        {issue.priority === 'none'
                          ? ''
                          : ` · ${PRIORITY_LABELS[issue.priority]}`}
                      </p>
                      {canEdit && (
                        <SelectField
                          id={`move-${issue.id}`}
                          label="Move to"
                          className="text-xs"
                          value={issue.status_id}
                          onChange={(event) => {
                            void move(issue.id, event.target.value).catch(
                              () => undefined
                            );
                          }}
                        >
                          {columns.map((target) => (
                            <option
                              key={target.status_id}
                              value={target.status_id}
                            >
                              {target.name}
                            </option>
                          ))}
                        </SelectField>
                      )}
                    </li>
                  ))}
                </ul>

                {rows.length === 0 && (
                  <p className="text-xs text-slate-500">Nothing here.</p>
                )}

                {cursor !== null && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    disabled={paging === column.status_id}
                    onClick={() => {
                      loadColumn(column);
                    }}
                  >
                    {paging === column.status_id ? 'Loading' : 'Load more'}
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default BoardView;
