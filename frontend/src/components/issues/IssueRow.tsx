/**
 * One issue as it reads in a list: the key, the title, and the status, assignee
 * and priority the filters sort on. The key doubles as the link, because the
 * key route is the one address a person can type from memory.
 */

import React from 'react';
import { Link } from 'react-router-dom';
import { PRIORITY_LABELS, progressPercent } from '../../lib/issueDisplay';
import { assigneeLabel, type Assignable } from '../../lib/issuePeople';
import type { IssueRead, LabelRead, StatusRead } from '../../types/Api';

/** Props for IssueRow: the issue, the workspace slug, and the lists to resolve ids against. */
export interface IssueRowProps {
  issue: IssueRead;
  slug: string;
  statuses: StatusRead[];
  labels: LabelRead[];
  people: Assignable[];
  /** The project key prefix to show, for a list that spans projects. */
  projectName?: string;
}

/** One row in an issue list. */
export const IssueRow: React.FC<IssueRowProps> = ({
  issue,
  slug,
  statuses,
  labels,
  people,
  projectName,
}) => {
  const status = statuses.find((item) => item.id === issue.status_id);
  const shown = labels.filter((label) => issue.label_ids.includes(label.id));

  return (
    <li className="rounded-md border border-slate-700 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          to={`/w/${slug}/issues/${issue.key}`}
          className="font-mono text-xs text-sky-400 hover:text-sky-300"
        >
          {issue.key}
        </Link>
        <Link
          to={`/w/${slug}/issues/${issue.key}`}
          className="text-sm text-slate-100 hover:text-white"
        >
          {issue.title}
        </Link>
        {projectName !== undefined && (
          <span className="text-xs text-slate-500">{projectName}</span>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
        <span>{status?.name ?? 'Unknown status'}</span>
        <span>{assigneeLabel(issue.assignee_id, people)}</span>
        {issue.priority !== 'none' && (
          <span>{PRIORITY_LABELS[issue.priority]}</span>
        )}
        {issue.estimate !== null && <span>Estimate {issue.estimate}</span>}
        {issue.due_date !== null && <span>Due {issue.due_date}</span>}
        {issue.progress.total > 0 && (
          <span>
            {issue.progress.completed} of {issue.progress.total} sub-issues done
          </span>
        )}
        {shown.map((label) => (
          <span key={label.id} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            {label.name}
          </span>
        ))}
      </div>

      {issue.progress.total > 0 && (
        <div
          role="progressbar"
          aria-label={`Sub-issues done for ${issue.key}`}
          aria-valuenow={progressPercent(issue.progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-slate-700"
        >
          <span
            className="block h-full bg-sky-500"
            style={{ width: `${String(progressPercent(issue.progress))}%` }}
          />
        </div>
      )}
    </li>
  );
};

export default IssueRow;
