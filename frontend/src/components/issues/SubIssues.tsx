/**
 * The direct children of one issue as a compact rail section. The count in the
 * header reads `progress` on the parent, which the rollup consumer maintains,
 * rather than counting the rows. A row opens its issue on click, and Space on a
 * focused row peeks it without leaving this page.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { usePeekIssue } from '../../hooks/usePeekIssue';
import { errorMessage } from '../../lib/errors';
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { issuePath } from '../../lib/paths';
import type { IssueProgress, IssueRead, StatusRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { StatusGlyph } from '../ui/glyphs';
import Skeleton from '../ui/skeleton';
import RailSection from './RailSection';

/** Props for SubIssues. */
export interface SubIssuesProps {
  slug: string;
  rows: IssueRead[];
  isLoading: boolean;
  error: unknown;
  progress: IssueProgress;
  statuses: StatusRead[];
  people: Assignable[];
  /** Opens the create dialog preset with this issue as the parent. Unset hides it. */
  onAdd?: () => void;
}

/** The sub-issues section of the rail. */
export const SubIssues: React.FC<SubIssuesProps> = ({
  slug,
  rows,
  isLoading,
  error,
  progress,
  statuses,
  people,
  onAdd,
}) => {
  const { peekIssue } = usePeekIssue();

  if (!isLoading && rows.length === 0 && onAdd === undefined) return null;

  return (
    <RailSection
      title="Sub-issues"
      {...(progress.total > 0
        ? { count: `${String(progress.completed)}/${String(progress.total)}` }
        : {})}
      {...(onAdd === undefined
        ? {}
        : { add: { label: 'Add sub-issue', onClick: onAdd } })}
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
      ) : rows.length === 0 ? (
        <p className="py-1 text-xs text-text-faint">No sub-issues</p>
      ) : (
        <ul aria-label="Sub-issues">
          {rows.map((child) => {
            const status = statuses.find(
              (candidate) => candidate.id === child.status_id
            );
            const assignee =
              child.assignee_id === null
                ? undefined
                : people.find((person) => person.user_id === child.assignee_id);
            return (
              <li key={child.id}>
                <Link
                  to={issuePath(slug, child.key)}
                  title={child.title}
                  className="-mx-1 flex h-7 items-center gap-1.5 rounded-sm px-1 text-xs transition-colors duration-100 hover:bg-raised"
                  onKeyDown={(event) => {
                    if (event.key !== ' ') return;
                    event.preventDefault();
                    peekIssue({ id: child.id, key: child.key });
                  }}
                >
                  <StatusGlyph
                    category={status?.category}
                    {...(status === undefined ? {} : { name: status.name })}
                  />
                  <span className="shrink-0 font-mono text-text-faint">
                    {child.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text">
                    {child.title}
                  </span>
                  {assignee !== undefined && (
                    <span title={personLabel(assignee)} className="shrink-0">
                      <Avatar name={personLabel(assignee)} size="xs" />
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
};

export default SubIssues;
