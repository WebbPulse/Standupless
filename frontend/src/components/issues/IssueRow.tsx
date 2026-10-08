/**
 * One issue as it reads in a list: a 36px row leading with the priority and
 * status glyphs, the mono key, the title, and the meta on the right. The key
 * is the link, stretched over the whole row so anywhere on it opens the issue,
 * because the key route is the one address a person can type from memory.
 *
 * Given `onFilter`, the priority, status, labels, estimate and assignee are
 * chips that narrow the list to their value instead of opening the issue.
 */

import React from 'react';
import { LuCalendar, LuUserRound } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { PRIORITY_LABELS, progressPercent } from '../../lib/issueDisplay';
import {
  assigneeLabel,
  avatarOf,
  type Assignable,
} from '../../lib/issuePeople';
import { NONE } from '../../api/issues';
import {
  labelsForIssue,
  statusForIssue,
  type FilterField,
  type ScopedLabel,
  type ScopedStatus,
} from '../../lib/issueView';
import type { IssueRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import Badge, { LabelChip } from '../ui/badge';
import BlockedMarker from './BlockedMarker';
import { FilterChipButton } from './ChipActions';
import SlaBadge from './SlaBadge';
import { PriorityGlyph } from '../ui/glyphs';
import { StatusIcon } from '../ui/StatusIcon';

/**
 * Props for IssueRow: the issue, the workspace slug, and the lists to resolve
 * ids against. The lists may span teams and repeat a workspace row per team.
 */
export interface IssueRowProps {
  issue: IssueRead;
  slug: string;
  statuses: ScopedStatus[];
  labels: ScopedLabel[];
  people: Assignable[];
  /** The team name to show, for a list that spans teams. */
  teamName?: string;
  /** True while the keyboard highlight sits on this row. */
  isActive?: boolean;
  /** Hands the row element up, so a highlighted row can be scrolled into view. */
  rowRef?: (node: HTMLLIElement | null) => void;
  /** Moves the keyboard highlight here when the pointer arrives. */
  onPointerEnter?: () => void;
  /** Narrows the list to one value of a field, making the chips clickable. */
  onFilter?: (field: FilterField, value: string) => void;
}

/** The look of a glyph that filters on a click. */
const GLYPH_FILTER =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm border border-transparent';

/** One row in an issue list. */
export const IssueRow: React.FC<IssueRowProps> = ({
  issue,
  slug,
  statuses,
  labels,
  people,
  teamName,
  isActive = false,
  rowRef,
  onPointerEnter,
  onFilter,
}) => {
  const status = statusForIssue(issue, statuses);
  const shown = labelsForIssue(issue, labels);
  const assignee = assigneeLabel(issue.assignee_id, people);
  const priorityName = PRIORITY_LABELS[issue.priority];
  const statusName = status?.name ?? 'Unknown status';

  const priorityGlyph = (
    <PriorityGlyph priority={issue.priority} name={priorityName} />
  );
  const statusGlyph = (
    <StatusIcon status={status} statuses={statuses} name={statusName} />
  );
  const assigneeGlyph =
    issue.assignee_id === null ? (
      <LuUserRound className="h-4 w-4 text-text-faint" aria-hidden="true" />
    ) : (
      <Avatar
        name={assignee}
        src={avatarOf(issue.assignee_id, people)}
        size="xs"
      />
    );

  return (
    <li
      ref={rowRef}
      onPointerEnter={onPointerEnter}
      aria-current={isActive ? 'true' : undefined}
      className={cn(
        'relative flex h-row items-center gap-2.5 border-b border-line px-4 transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6',
        isActive &&
          'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
      )}
    >
      {onFilter === undefined ? (
        priorityGlyph
      ) : (
        <FilterChipButton
          tooltip={`Filter by priority: ${priorityName}`}
          onFilter={() => {
            onFilter('priority', issue.priority);
          }}
          className={GLYPH_FILTER}
        >
          {priorityGlyph}
        </FilterChipButton>
      )}
      <Link
        to={`/w/${slug}/issues/${issue.key}`}
        data-hover="parent"
        className="w-12 shrink-0 truncate font-mono text-xs text-text-faint after:absolute sm:w-16 after:inset-0 after:rounded-xs focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
      >
        {issue.key}
      </Link>
      {onFilter === undefined ? (
        statusGlyph
      ) : (
        <FilterChipButton
          tooltip={`Filter by status: ${statusName}`}
          onFilter={() => {
            onFilter('status', issue.status_id);
          }}
          className={GLYPH_FILTER}
        >
          {statusGlyph}
        </FilterChipButton>
      )}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
        {issue.title}
      </span>
      <BlockedMarker count={issue.blocked_by_open_count} />

      <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
        {teamName !== undefined && (
          <span className="hidden text-text-faint md:inline">{teamName}</span>
        )}
        {shown.map((label) =>
          onFilter === undefined ? (
            <LabelChip
              key={label.id}
              color={label.color}
              name={label.name}
              className="hidden sm:inline-flex"
            />
          ) : (
            <FilterChipButton
              key={label.id}
              tooltip={`Filter by label: ${label.name}`}
              onFilter={() => {
                onFilter('label', label.id);
              }}
              wrapperClassName="hidden sm:inline-flex"
              className="rounded-full"
            >
              <LabelChip
                color={label.color}
                name={label.name}
                className="hover:border-line-strong"
              />
            </FilterChipButton>
          )
        )}
        {issue.progress.total > 0 && (
          <span
            role="progressbar"
            aria-label={`Sub-issues done for ${issue.key}`}
            aria-valuenow={progressPercent(issue.progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="hidden text-text-faint sm:inline"
          >
            {issue.progress.completed}/{issue.progress.total}
          </span>
        )}
        {issue.estimate !== null &&
          (onFilter === undefined ? (
            <Badge className="hidden sm:inline-flex">{issue.estimate}</Badge>
          ) : (
            <FilterChipButton
              tooltip={`Filter by estimate: ${issue.estimate}`}
              onFilter={() => {
                onFilter('estimate', issue.estimate ?? NONE);
              }}
              wrapperClassName="hidden sm:inline-flex"
              className="rounded-sm"
            >
              <Badge>{issue.estimate}</Badge>
            </FilterChipButton>
          ))}
        {issue.due_date !== null && (
          <span className="hidden items-center gap-1 sm:inline-flex">
            <LuCalendar
              className="h-3 w-3 text-text-faint"
              aria-hidden="true"
            />
            <span className="sr-only">Due</span>
            {issue.due_date}
          </span>
        )}
        <SlaBadge issue={issue} className="hidden sm:inline-flex" />
        {onFilter === undefined ? (
          <>
            {assigneeGlyph}
            <span className="sr-only">{assignee}</span>
          </>
        ) : (
          <FilterChipButton
            tooltip={`Filter by assignee: ${assignee}`}
            onFilter={() => {
              onFilter('assignee', issue.assignee_id ?? NONE);
            }}
            className={GLYPH_FILTER}
          >
            {assigneeGlyph}
          </FilterChipButton>
        )}
      </span>
    </li>
  );
};

export default IssueRow;
