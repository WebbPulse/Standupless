/**
 * One team's board: a column per status, each capped by the board read and
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
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import EmptyState from '../ui/empty-state';
import { PriorityGlyph, StatusGlyph } from '../ui/glyphs';
import { SelectField } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for BoardView: which team, who may move a card, and the lists. */
export interface BoardViewProps {
  workspaceId: string;
  teamId: string;
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

/** Reads one team's board and moves cards between its columns. */
export const BoardView: React.FC<BoardViewProps> = ({
  workspaceId,
  teamId,
  slug,
  filters,
  people,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const [extra, setExtra] = useState<Extra>({});
  const [paging, setPaging] = useState<string | null>(null);
  const queryKey = boardKey(workspaceId, teamId, filters);

  const enabled = workspaceId !== '' && teamId !== '';

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
    ({ signal }) => getBoard(workspaceId, teamId, query, signal),
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
      listBoardColumn(workspaceId, column.status_id, teamId, {
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
    [workspaceId, teamId, extra, query]
  );

  const columns = data?.columns ?? [];

  if (isLoading) return <Spinner label="Loading board" />;

  return (
    <div className="flex shrink-0 flex-col lg:min-h-0 lg:flex-1">
      {(error !== null || moveError !== null) && (
        <div className="space-y-2 px-4 pt-3 lg:px-6">
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
        </div>
      )}

      {columns.length === 0 ? (
        <EmptyState message="This team has no statuses yet." />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pt-3 pb-4 lg:px-6">
          {columns.map((column) => {
            const held = extra[column.status_id];
            const rows = [...column.issues, ...(held?.rows ?? [])];
            const cursor =
              held === undefined ? column.next_cursor : held.cursor;
            return (
              <section
                key={column.status_id}
                aria-label={column.name}
                className="flex max-h-full w-64 shrink-0 flex-col self-start rounded-md bg-surface"
              >
                <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
                  <StatusGlyph category={column.category} />
                  <h3 className="truncate text-sm font-medium text-text">
                    {column.name}
                  </h3>
                  <span className="ml-auto text-xs text-text-faint">
                    {column.total}
                  </span>
                </header>

                <ul className="min-h-0 space-y-2 overflow-y-auto px-2 pb-2">
                  {rows.map((issue) => {
                    const assignee = assigneeLabel(issue.assignee_id, people);
                    return (
                      <li
                        key={issue.id}
                        className="space-y-1.5 rounded-md border border-line bg-bg px-2.5 py-2 transition-colors duration-100 hover:border-line-strong"
                      >
                        <Link
                          to={`/w/${slug}/issues/${issue.key}`}
                          className="block space-y-1 rounded-xs"
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-text-faint">
                              {issue.key}
                            </span>
                            <PriorityGlyph
                              priority={issue.priority}
                              name={PRIORITY_LABELS[issue.priority]}
                              className="ml-auto"
                            />
                          </span>
                          <span className="block text-sm font-medium text-text">
                            {issue.title}
                          </span>
                        </Link>
                        <div className="flex items-center gap-2">
                          {issue.assignee_id !== null && (
                            <Avatar name={assignee} size="xs" />
                          )}
                          <span className="truncate text-xs text-text-muted">
                            {assignee}
                          </span>
                          {canEdit && (
                            <SelectField
                              id={`move-${issue.id}`}
                              label="Move to"
                              hideLabel
                              className="ml-auto w-28"
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
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {rows.length === 0 && (
                  <p className="px-2.5 pb-3 text-xs text-text-faint">
                    Nothing here.
                  </p>
                )}

                {cursor !== null && (
                  <div className="px-2 pb-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      disabled={paging === column.status_id}
                      onClick={() => {
                        loadColumn(column);
                      }}
                    >
                      {paging === column.status_id ? 'Loading' : 'Load more'}
                    </Button>
                  </div>
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
