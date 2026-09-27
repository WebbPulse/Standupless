/**
 * The properties an issue shows on a list row or a board card. Priority,
 * status and assignee are inline pickers that write optimistically, since
 * those are what people change while scanning a list; the rest are compact
 * chips, changed from the keyboard or the issue itself. Each respects the
 * view's visible properties, so hiding a property hides it everywhere.
 */

import React from 'react';
import {
  LuBox,
  LuCalendar,
  LuCalendarClock,
  LuIterationCw,
  LuListTree,
  LuTriangle,
} from 'react-icons/lu';
import type { OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import { labelsOf } from '../../../lib/issueView';
import { shortDateLabel } from '../../../lib/propertyOptions';
import { LabelChip } from '../../ui/badge';
import {
  AssigneePicker,
  PriorityPicker,
  StatusPicker,
} from '../PropertyPickers';
import { useIssueViewEnv } from './IssueViewContext';

/** Props shared by every property cell: the issue it shows. */
export interface IssueCellProps {
  issue: OrderedIssueRead;
  className?: string;
}

/** The layer a picker sits on, above the row's stretched link. */
const ABOVE_LINK = 'relative z-10';

/** The issue's priority as an inline picker. */
export const PriorityCell: React.FC<IssueCellProps> = ({
  issue,
  className,
}) => {
  const { update, canEdit } = useIssueViewEnv();
  return (
    <PriorityPicker
      variant="icon"
      value={issue.priority}
      disabled={!canEdit}
      className={cn(ABOVE_LINK, className)}
      onChange={(priority) => {
        update([issue.id], { priority });
      }}
    />
  );
};

/** The issue's status as an inline picker, offering its own team's statuses. */
export const StatusCell: React.FC<IssueCellProps> = ({ issue, className }) => {
  const { update, canEdit, forTeam } = useIssueViewEnv();
  return (
    <StatusPicker
      variant="icon"
      statuses={forTeam(issue.team_id).statuses}
      value={issue.status_id}
      disabled={!canEdit}
      className={cn(ABOVE_LINK, className)}
      onChange={(statusId) => {
        update([issue.id], { status_id: statusId });
      }}
    />
  );
};

/** The issue's assignee as an avatar opening a picker. */
export const AssigneeCell: React.FC<IssueCellProps> = ({
  issue,
  className,
}) => {
  const { update, canEdit, forTeam, context } = useIssueViewEnv();
  const own = forTeam(issue.team_id);
  return (
    <AssigneePicker
      variant="icon"
      align="end"
      people={own.people.length > 0 ? own.people : context.people}
      value={issue.assignee_id}
      disabled={!canEdit}
      className={cn(ABOVE_LINK, className)}
      {...(context.currentUserId === undefined
        ? {}
        : { currentUserId: context.currentUserId })}
      onChange={(assigneeId) => {
        update([issue.id], { assignee_id: assigneeId });
      }}
    />
  );
};

/** A quiet bordered chip for one property value. */
const Chip: React.FC<{
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
  className?: string;
}> = ({ icon, label, children, className }) => (
  <span
    title={label}
    className={cn(
      'inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-2xs whitespace-nowrap text-text-muted',
      className
    )}
  >
    {icon}
    <span className="truncate">{children}</span>
  </span>
);

/** How many labels a row shows before folding the rest into a count. */
const LABELS_SHOWN = 3;

/** A timestamp as a short day. */
const dayOf = (value: string): string => shortDateLabel(value.slice(0, 10));

/** Whether a due date has passed, compared as local calendar days. */
const isOverdue = (due: string): boolean => {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const date = String(today.getDate()).padStart(2, '0');
  return due < `${String(today.getFullYear())}-${month}-${date}`;
};

/** Props for MetaChips: the issue and whether it is drawn on a card. */
export interface MetaChipsProps {
  issue: OrderedIssueRead;
  /** True on a board card, where the chips wrap under the title. */
  card?: boolean;
}

/**
 * The chips after the title: sub-issue progress, labels, project, cycle,
 * estimate and dates, each only when the view shows it and the issue has it.
 */
export const MetaChips: React.FC<MetaChipsProps> = ({
  issue,
  card = false,
}) => {
  const { state, context, teamNameFor } = useIssueViewEnv();
  const shows = (property: (typeof state.visible)[number]): boolean =>
    state.visible.includes(property);
  const labels = labelsOf(issue, context);
  const project = context.projects.find(
    (item) => item.project_id === issue.project_id
  );
  const cycle = context.cycles.find((item) => item.cycle_id === issue.cycle_id);
  const teamName = teamNameFor?.(issue.team_id);
  const hide = card ? '' : 'hidden md:inline-flex';

  return (
    <>
      {shows('sub_issues') && issue.progress.total > 0 && (
        <Chip
          label="Sub-issues done"
          icon={<LuListTree aria-hidden="true" className="h-3 w-3" />}
          className={hide}
        >
          {issue.progress.completed}/{issue.progress.total}
        </Chip>
      )}
      {shows('labels') &&
        labels
          .slice(0, LABELS_SHOWN)
          .map((label) => (
            <LabelChip
              key={label.id}
              color={label.color}
              name={label.name}
              className={cn('max-w-32', hide)}
            />
          ))}
      {shows('labels') && labels.length > LABELS_SHOWN && (
        <Chip
          label={labels
            .slice(LABELS_SHOWN)
            .map((label) => label.name)
            .join(', ')}
          className={hide}
        >
          +{labels.length - LABELS_SHOWN}
        </Chip>
      )}
      {shows('project') && project !== undefined && (
        <Chip
          label="Project"
          icon={<LuBox aria-hidden="true" className="h-3 w-3" />}
          className={card ? '' : 'hidden lg:inline-flex'}
        >
          {project.name}
        </Chip>
      )}
      {shows('cycle') && cycle !== undefined && (
        <Chip
          label="Cycle"
          icon={<LuIterationCw aria-hidden="true" className="h-3 w-3" />}
          className={card ? '' : 'hidden lg:inline-flex'}
        >
          {cycle.name}
        </Chip>
      )}
      {shows('estimate') && issue.estimate !== null && (
        <Chip
          label="Estimate"
          icon={<LuTriangle aria-hidden="true" className="h-3 w-3" />}
          className={hide}
        >
          {issue.estimate}
        </Chip>
      )}
      {shows('start_date') && issue.start_date !== null && (
        <Chip
          label="Start date"
          icon={<LuCalendarClock aria-hidden="true" className="h-3 w-3" />}
          className={hide}
        >
          {shortDateLabel(issue.start_date)}
        </Chip>
      )}
      {shows('due_date') && issue.due_date !== null && (
        <Chip
          label="Due date"
          icon={<LuCalendar aria-hidden="true" className="h-3 w-3" />}
          className={cn(
            hide,
            isOverdue(issue.due_date) && 'border-danger/40 text-danger'
          )}
        >
          {shortDateLabel(issue.due_date)}
        </Chip>
      )}
      {teamName !== undefined && (
        <span className={cn('text-2xs text-text-faint', hide)}>{teamName}</span>
      )}
      {shows('created_at') && (
        <span
          title="Created"
          className={cn('w-14 text-right text-2xs text-text-faint', hide)}
        >
          {dayOf(issue.created_at)}
        </span>
      )}
      {shows('updated_at') && (
        <span
          title="Updated"
          className={cn('w-14 text-right text-2xs text-text-faint', hide)}
        >
          {dayOf(issue.updated_at)}
        </span>
      )}
    </>
  );
};
