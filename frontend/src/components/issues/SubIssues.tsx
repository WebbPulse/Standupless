/**
 * The direct children of one issue as a compact rail section. The count in the
 * header reads `progress` on the parent, which the rollup consumer maintains,
 * until every child is loaded; from then it counts the rows, so a status picked
 * or a child added here shows at once rather than when the rollup lands. A row
 * opens its issue on click, Space on a focused row peeks it without leaving
 * this page, and its status icon opens the status picker. The add button opens
 * an inline row that files a child per Enter and stays open for the next one.
 */

import React, { useMemo, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import { Link } from 'react-router-dom';
import { createIssue, type OrderedIssueRead } from '../../api/issues';
import { useOptimisticIssues } from '../../hooks/useOptimisticIssues';
import { usePeekIssue } from '../../hooks/usePeekIssue';
import { useTriageOn } from '../../hooks/useTriageTeams';
import { errorMessage } from '../../lib/errors';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { issuePath } from '../../lib/paths';
import { activityKey, childrenKey } from '../../lib/queryKeys';
import { showErrorToast } from '../../lib/toast';
import { shownStatusId } from '../../lib/triageStatus';
import { TITLE_MAX } from '../../lib/validation';
import type { IssueProgress, IssueRead, StatusRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { StatusIcon } from '../ui/StatusIcon';
import Skeleton from '../ui/skeleton';
import { StatusPicker } from './PropertyPickers';
import RailSection from './RailSection';

/** Props for SubIssues. */
export interface SubIssuesProps {
  workspaceId: string;
  slug: string;
  /** The issue the rows hang off, whose team a new child is filed in. */
  parent: Pick<IssueRead, 'id' | 'team_id'>;
  rows: IssueRead[];
  isLoading: boolean;
  error: unknown;
  progress: IssueProgress;
  statuses: StatusRead[];
  people: Assignable[];
  /** Offers the status pickers and the inline add row. */
  canEdit?: boolean;
}

/** The categories the rollup counts as done. */
const DONE_CATEGORIES: ReadonlySet<string> = new Set([
  'completed',
  'cancelled',
]);

/**
 * The count the header shows: the rows once every child is loaded, counted as
 * the rollup counts them, else the rollup itself.
 */
const shownProgress = (
  progress: IssueProgress,
  rows: readonly IssueRead[],
  statuses: readonly StatusRead[],
  complete: boolean
): IssueProgress => {
  if (!complete || rows.length < progress.total) return progress;
  const categories = new Map(
    statuses.map((status) => [status.id, status.category])
  );
  const completed = rows.filter((row) =>
    DONE_CATEGORIES.has(categories.get(row.status_id) ?? '')
  ).length;
  return { total: rows.length, completed };
};

/** The inline row a child is typed into, Enter filing it and Escape leaving. */
const AddSubIssueRow: React.FC<{
  onCreate: (title: string) => Promise<boolean>;
  onDone: () => void;
}> = ({ onCreate, onDone }) => {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (): void => {
    const trimmed = title.trim();
    if (trimmed === '') return;
    setTitle('');
    void onCreate(trimmed.slice(0, TITLE_MAX)).then((created) => {
      if (created) return;
      setTitle((held) => (held === '' ? trimmed : held));
    });
    inputRef.current?.focus();
  };
  return (
    <form
      className="-mx-1 flex h-7 items-center gap-1.5 px-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <span aria-hidden="true" className="flex h-6 w-6 justify-center">
        <StatusIcon />
      </span>
      <input
        ref={inputRef}
        aria-label="New sub-issue title"
        placeholder="Sub-issue title, then Enter"
        autoFocus
        maxLength={TITLE_MAX}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onBlur={() => {
          if (title.trim() === '') onDone();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onDone();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-xs text-text placeholder:text-text-faint focus:outline-none"
      />
    </form>
  );
};

/** The sub-issues section of the rail. */
export const SubIssues: React.FC<SubIssuesProps> = ({
  workspaceId,
  slug,
  parent,
  rows,
  isLoading,
  error,
  progress,
  statuses,
  people,
  canEdit = false,
}) => {
  const { peekIssue } = usePeekIssue();
  const triageOn = useTriageOn(parent.team_id);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<IssueRead[]>([]);

  const heldIds = useMemo(() => new Set(rows.map((row) => row.id)), [rows]);
  if (created.some((row) => heldIds.has(row.id))) {
    setCreated((pending) => pending.filter((row) => !heldIds.has(row.id)));
  }

  const read = useMemo<OrderedIssueRead[]>(
    () => [...rows, ...created.filter((row) => !heldIds.has(row.id))],
    [rows, created, heldIds]
  );

  const { issues: shown, update } = useOptimisticIssues(
    workspaceId,
    read,
    childrenKey(parent.id)
  );

  const count = shownProgress(
    progress,
    shown,
    statuses,
    !isLoading && (error === null || error === undefined)
  );

  const addChild = async (title: string): Promise<boolean> => {
    try {
      const child = await createIssue(workspaceId, {
        team_id: parent.team_id,
        title,
        parent_id: parent.id,
      });
      setCreated((pending) => [...pending, child]);
    } catch (cause) {
      showErrorToast(errorMessage(cause, 'Could not create that sub-issue.'));
      return false;
    }
    invalidateQueries([childrenKey(parent.id), activityKey(parent.id)]);
    return true;
  };

  if (!isLoading && shown.length === 0 && !canEdit) return null;

  return (
    <RailSection
      title="Sub-issues"
      {...(count.total > 0
        ? { count: `${String(count.completed)}/${String(count.total)}` }
        : {})}
      {...(canEdit
        ? {
            add: {
              label: 'Add sub-issue',
              onClick: () => {
                setAdding(true);
              },
            },
          }
        : {})}
    >
      {error !== null && error !== undefined && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the sub-issues.')}
        />
      )}
      {isLoading ? (
        <div role="status" aria-label="Loading sub-issues" className="py-1">
          <Skeleton className="h-4 w-full" />
        </div>
      ) : shown.length === 0 ? (
        !adding && <p className="py-1 text-xs text-text-faint">No sub-issues</p>
      ) : (
        <ul aria-label="Sub-issues">
          {shown.map((child) => {
            const assignee =
              child.assignee_id === null
                ? undefined
                : people.find((person) => person.user_id === child.assignee_id);
            return (
              <li
                key={child.id}
                className="-mx-1 flex h-7 items-center gap-0.5 rounded-sm pl-0.5 transition-colors duration-100 hover:bg-raised"
              >
                <StatusPicker
                  variant="icon"
                  statuses={statuses}
                  triage={triageOn}
                  value={shownStatusId(child)}
                  disabled={!canEdit}
                  onChange={(statusId) => {
                    update([child.id], { status_id: statusId });
                  }}
                  className="shrink-0"
                />
                <Link
                  to={issuePath(slug, child.key)}
                  title={child.title}
                  className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm pr-1 text-xs"
                  onKeyDown={(event) => {
                    if (event.key !== ' ') return;
                    event.preventDefault();
                    peekIssue({ id: child.id, key: child.key });
                  }}
                >
                  <span className="shrink-0 font-mono text-text-faint">
                    {child.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {child.title}
                  </span>
                  {assignee !== undefined && (
                    <span title={personLabel(assignee)} className="shrink-0">
                      <Avatar
                        name={personLabel(assignee)}
                        src={personAvatar(assignee)}
                        size="xs"
                      />
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {canEdit && adding && (
        <AddSubIssueRow
          onCreate={addChild}
          onDone={() => {
            setAdding(false);
          }}
        />
      )}
    </RailSection>
  );
};

export default SubIssues;
