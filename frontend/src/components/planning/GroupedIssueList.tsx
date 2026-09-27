/**
 * The issues of a project or a cycle, grouped by where they are in the
 * workflow: in progress first, then todo, backlog, done and canceled. Each
 * group has a sticky header that folds it away, and the rows are the same
 * rows every issue list draws. j and k move through the open groups, Enter
 * opens the highlighted issue and Space peeks it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { LuChevronRight, LuInbox, LuPlus } from 'react-icons/lu';
import { useNavigate } from 'react-router-dom';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { usePeekIssue } from '../../hooks/usePeekIssue';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import type { Assignable } from '../../lib/issuePeople';
import {
  ISSUE_GROUP_LABELS,
  groupIssuesByCategory,
} from '../../lib/planningModel';
import type {
  IssueRead,
  LabelRead,
  StatusCategory,
  StatusRead,
} from '../../types/Api';
import IssueRow from '../issues/IssueRow';
import { ErrorAlert } from '../ui/alert';
import Button, { IconButton } from '../ui/button';
import EmptyState from '../ui/empty-state';
import { StatusGlyph } from '../ui/glyphs';
import { SkeletonRows } from '../ui/skeleton';

/** Props for GroupedIssueList: the rows read so far and the lists to resolve ids against. */
export interface GroupedIssueListProps {
  issues: IssueRead[];
  isLoading: boolean;
  error: unknown;
  hasMore?: boolean;
  isPaging?: boolean;
  loadMore?: () => void;
  slug: string;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  teamNameFor?: (issue: IssueRead) => string | undefined;
  emptyMessage: string;
  /** Opens the new issue dialog in this context, when the caller may write. */
  onCreate?: () => void;
}

/** An issue list grouped by status category. */
export const GroupedIssueList: React.FC<GroupedIssueListProps> = ({
  issues,
  isLoading,
  error,
  hasMore = false,
  isPaging = false,
  loadMore,
  slug,
  statuses,
  labels,
  people,
  teamNameFor,
  emptyMessage,
  onCreate,
}) => {
  const [folded, setFolded] = useState<StatusCategory[]>(['cancelled']);
  const groups = useMemo(
    () => groupIssuesByCategory(issues, statuses),
    [issues, statuses]
  );
  const visible = useMemo(
    () =>
      groups
        .filter((group) => !folded.includes(group.key))
        .flatMap((group) => group.rows),
    [groups, folded]
  );
  const starts = useMemo(
    () =>
      groups.map((_, index) =>
        groups
          .slice(0, index)
          .filter((group) => !folded.includes(group.key))
          .reduce((sum, group) => sum + group.rows.length, 0)
      ),
    [groups, folded]
  );
  const navigate = useNavigate();
  const { peekIssue } = usePeekIssue();

  const onActivate = useCallback(
    (index: number) => {
      const issue = visible[index];
      if (issue !== undefined) void navigate(`/w/${slug}/issues/${issue.key}`);
    },
    [visible, navigate, slug]
  );

  const onPeek = useCallback(
    (index: number) => {
      const issue = visible[index];
      if (issue !== undefined) peekIssue(issue);
    },
    [visible, peekIssue]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: visible.length,
    onActivate,
    onPeek,
    resetKey: `${folded.join(',')}:${String(issues.length)}`,
  });

  if (isLoading) return <SkeletonRows label="Loading issues" />;

  return (
    <div>
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load these issues.')}
          />
        </div>
      )}
      {groups.length === 0 ? (
        <EmptyState message={emptyMessage} icon={<LuInbox />} />
      ) : (
        groups.map((group, groupIndex) => {
          const isOpen = !folded.includes(group.key);
          const start = starts[groupIndex] ?? 0;
          return (
            <section key={group.key} aria-label={ISSUE_GROUP_LABELS[group.key]}>
              <div className="group/header sticky top-0 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 lg:px-6">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => {
                    setFolded((held) =>
                      held.includes(group.key)
                        ? held.filter((key) => key !== group.key)
                        : [...held, group.key]
                    );
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <LuChevronRight
                    aria-hidden="true"
                    className={cn(
                      'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
                      isOpen && 'rotate-90'
                    )}
                  />
                  <StatusGlyph category={group.key} />
                  {ISSUE_GROUP_LABELS[group.key]}
                  <span className="text-xs font-normal text-text-faint tabular-nums">
                    {String(group.rows.length)}
                  </span>
                </button>
                {onCreate !== undefined && (
                  <IconButton
                    label={`New issue in ${ISSUE_GROUP_LABELS[group.key]}`}
                    size="sm"
                    className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
                    onClick={onCreate}
                  >
                    <LuPlus className="h-3.5 w-3.5" />
                  </IconButton>
                )}
              </div>
              {isOpen && (
                <ul>
                  {group.rows.map((issue, index) => {
                    const position = start + index;
                    const teamName = teamNameFor?.(issue);
                    return (
                      <IssueRow
                        key={issue.id}
                        issue={issue}
                        slug={slug}
                        statuses={statuses}
                        labels={labels}
                        people={people}
                        isActive={position === activeIndex}
                        rowRef={registerItem(position)}
                        onPointerEnter={() => {
                          setActiveIndex(position);
                        }}
                        {...(teamName === undefined ? {} : { teamName })}
                      />
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}
      {hasMore && loadMore !== undefined && (
        <div className="px-4 py-2 lg:px-6">
          <Button
            variant="ghost"
            size="sm"
            disabled={isPaging}
            onClick={loadMore}
          >
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default GroupedIssueList;
