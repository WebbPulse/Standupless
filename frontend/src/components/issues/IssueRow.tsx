/**
 * One issue as it reads in a list: a 36px row leading with the priority and
 * status glyphs, the mono key, the title, and the meta on the right. The key
 * is the link, stretched over the whole row so anywhere on it opens the issue,
 * because the key route is the one address a person can type from memory.
 */

import React from 'react';
import { LuCalendar, LuUserRound } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { PRIORITY_LABELS, progressPercent } from '../../lib/issueDisplay';
import { assigneeLabel, type Assignable } from '../../lib/issuePeople';
import type { IssueRead, LabelRead, StatusRead } from '../../types/Api';
import Avatar from '../ui/avatar';
import Badge, { LabelChip } from '../ui/badge';
import { PriorityGlyph, StatusGlyph } from '../ui/glyphs';

/** Props for IssueRow: the issue, the workspace slug, and the lists to resolve ids against. */
export interface IssueRowProps {
  issue: IssueRead;
  slug: string;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** The team name to show, for a list that spans teams. */
  teamName?: string;
}

/** One row in an issue list. */
export const IssueRow: React.FC<IssueRowProps> = ({
  issue,
  slug,
  statuses,
  labels,
  people,
  teamName,
}) => {
  const status = statuses.find((item) => item.id === issue.status_id);
  const shown = labels.filter((label) => issue.label_ids.includes(label.id));
  const assignee = assigneeLabel(issue.assignee_id, people);

  return (
    <li className="relative flex h-row items-center gap-2.5 border-b border-line px-4 transition-colors duration-100 hover:bg-surface lg:px-6">
      <PriorityGlyph
        priority={issue.priority}
        name={PRIORITY_LABELS[issue.priority]}
      />
      <Link
        to={`/w/${slug}/issues/${issue.key}`}
        className="w-12 shrink-0 truncate font-mono text-xs text-text-faint after:absolute sm:w-16 after:inset-0 after:rounded-xs focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
      >
        {issue.key}
      </Link>
      <StatusGlyph
        category={status?.category}
        name={status?.name ?? 'Unknown status'}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
        {issue.title}
      </span>

      <span className="flex shrink-0 items-center gap-2 text-xs text-text-muted">
        {teamName !== undefined && (
          <span className="hidden text-text-faint md:inline">{teamName}</span>
        )}
        {shown.map((label) => (
          <LabelChip
            key={label.id}
            color={label.color}
            name={label.name}
            className="hidden sm:inline-flex"
          />
        ))}
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
        {issue.estimate !== null && (
          <Badge className="hidden sm:inline-flex">{issue.estimate}</Badge>
        )}
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
        {issue.assignee_id === null ? (
          <LuUserRound className="h-4 w-4 text-text-faint" aria-hidden="true" />
        ) : (
          <Avatar name={assignee} size="xs" />
        )}
        <span className="sr-only">{assignee}</span>
      </span>
    </li>
  );
};

export default IssueRow;
