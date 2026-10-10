/**
 * The properties an issue shows on a list row or a board card. Priority,
 * status and assignee are inline pickers that write optimistically, since
 * those are what people change while scanning a list; the rest are compact
 * chips, changed from the keyboard or the issue itself. Each respects the
 * view's visible properties, so hiding a property hides it everywhere.
 *
 * Chips act on a click: a project or cycle chip opens its page, and a label
 * or estimate chip narrows the view to that value. Where a person cannot edit,
 * the priority, status and assignee glyphs narrow the view the same way.
 */

import React from 'react';
import {
  LuBox,
  LuCalendar,
  LuCalendarClock,
  LuIterationCw,
  LuListTree,
  LuCircleDashed,
  LuTriangle,
} from 'react-icons/lu';
import { NONE, type OrderedIssueRead } from '../../../api/issues';
import { cn } from '../../../lib/cn';
import { PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import { labelsOf, type FilterField } from '../../../lib/issueView';
import { pullRequestChipStyle } from '../../../lib/pullRequestState';
import { cyclePath, projectPath } from '../../../lib/paths';
import { shortDateLabel } from '../../../lib/propertyOptions';
import Avatar from '../../ui/avatar';
import { LabelChip } from '../../ui/badge';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import { Tooltip } from '../../ui/tooltip';
import {
  CHIP_ACTION_CLASS,
  FilterChipButton,
  NavChipLink,
} from '../ChipActions';
import SlaBadge from '../SlaBadge';
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

/**
 * The layer a picker sits on, above the row's stretched link. On a touch
 * screen the glyphs are too small to tap apart from the row, so taps pass
 * through to the link and the issue opens, where every property is editable.
 */
const ABOVE_LINK = 'relative z-10 pointer-coarse:pointer-events-none';

/** The look of a read-only glyph that filters on a click. */
const GLYPH_FILTER =
  'inline-flex h-6 w-6 items-center justify-center rounded-sm border border-transparent text-text-muted';

/** The filter a read-only cell runs on a click, or undefined to stay a picker. */
const useReadOnlyFilter = (
  field: FilterField
): ((value: string) => void) | undefined => {
  const { canEdit, filterFor } = useIssueViewEnv();
  return canEdit ? undefined : filterFor?.(field);
};

/** The issue's priority as an inline picker. */
export const PriorityCell: React.FC<IssueCellProps> = ({
  issue,
  className,
}) => {
  const { update, canEdit } = useIssueViewEnv();
  const onFilter = useReadOnlyFilter('priority');
  if (onFilter !== undefined) {
    const name = PRIORITY_LABELS[issue.priority];
    return (
      <FilterChipButton
        tooltip={`Filter by priority: ${name}`}
        onFilter={() => {
          onFilter(issue.priority);
        }}
        wrapperClassName={cn('pointer-coarse:pointer-events-none', className)}
        className={GLYPH_FILTER}
      >
        <PriorityGlyph priority={issue.priority} />
      </FilterChipButton>
    );
  }
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
  const onFilter = useReadOnlyFilter('status');
  if (onFilter !== undefined) {
    const statuses = forTeam(issue.team_id).statuses;
    const status = statuses.find((item) => item.id === issue.status_id);
    return (
      <FilterChipButton
        tooltip={`Filter by status: ${status?.name ?? 'Unknown status'}`}
        onFilter={() => {
          onFilter(issue.status_id);
        }}
        wrapperClassName={cn('pointer-coarse:pointer-events-none', className)}
        className={GLYPH_FILTER}
      >
        <StatusIcon status={status} statuses={statuses} />
      </FilterChipButton>
    );
  }
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
  const onFilter = useReadOnlyFilter('assignee');
  if (onFilter !== undefined) {
    const people = own.people.length > 0 ? own.people : context.people;
    const person = people.find((item) => item.user_id === issue.assignee_id);
    const name =
      issue.assignee_id === null ? 'No assignee' : personLabel(person);
    return (
      <FilterChipButton
        tooltip={`Filter by assignee: ${name}`}
        onFilter={() => {
          onFilter(issue.assignee_id ?? NONE);
        }}
        wrapperClassName={cn('pointer-coarse:pointer-events-none', className)}
        className={GLYPH_FILTER}
      >
        {issue.assignee_id === null ? (
          <LuCircleDashed aria-hidden="true" className="h-3.5 w-3.5" />
        ) : (
          <Avatar name={name} src={personAvatar(person)} size="xs" />
        )}
      </FilterChipButton>
    );
  }
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

/** The shape of a quiet bordered chip. */
const CHIP_CLASS =
  'inline-flex h-5 max-w-40 shrink-0 items-center gap-1 rounded-full border border-line px-1.5 text-2xs whitespace-nowrap text-text-muted';

/** A quiet bordered chip for one property value. */
const Chip: React.FC<{
  icon?: React.ReactNode;
  label: string;
  children: React.ReactNode;
  className?: string;
}> = ({ icon, label, children, className }) => (
  <span title={label} className={cn(CHIP_CLASS, className)}>
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

/** How long a pull request title runs in the chip's hover list before it is cut. */
const PR_TITLE_SHOWN = 60;

/** One pull request as a line of the chip's hover list. */
const pullRequestLine = (entry: {
  repository_full_name: string;
  number: number;
  title: string;
  state: string;
  review_state: string;
}): string => {
  const title =
    entry.title.length > PR_TITLE_SHOWN
      ? `${entry.title.slice(0, PR_TITLE_SHOWN - 1)}…`
      : entry.title;
  const name = `${entry.repository_full_name}#${String(entry.number)}`;
  const label = pullRequestChipStyle(entry).label;
  return title ? `${name} ${title} (${label})` : `${name} (${label})`;
};

/**
 * The issue's linked pull requests as one chip: the most advanced one's
 * state glyph, then its number, or a count when there are several. Hovering
 * lists each one, and a click opens the lead pull request on GitHub.
 */
export const PullRequestChip: React.FC<{
  issue: OrderedIssueRead;
  className?: string;
}> = ({ issue, className }) => {
  const summary = issue.pull_request_summary;
  const lead = summary?.pull_requests[0];
  if (summary === undefined || summary === null || lead === undefined)
    return null;
  const style = pullRequestChipStyle(lead);
  const Icon = style.icon;
  const lines = summary.pull_requests.map(pullRequestLine);
  const hidden = summary.count - summary.pull_requests.length;
  if (hidden > 0) lines.push(`and ${String(hidden)} more`);
  const several = summary.count > 1;
  const label = several
    ? `${String(summary.count)} pull requests`
    : `Pull request #${String(lead.number)}`;
  return (
    <span className={cn('relative z-10 shrink-0', className)}>
      <Tooltip text={lines.join('\n')}>
        <a
          href={lead.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${label}, ${style.label}`}
          draggable={false}
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ')
              event.stopPropagation();
          }}
          className={cn(CHIP_CLASS, CHIP_ACTION_CLASS)}
        >
          <Icon
            aria-hidden="true"
            data-testid="pull-request-chip-glyph"
            className={cn('h-3 w-3', style.colorClass)}
          />
          <span className="truncate">
            {several
              ? `${String(summary.count)} PRs`
              : `#${String(lead.number)}`}
          </span>
        </a>
      </Tooltip>
    </span>
  );
};

/** Props for MetaChips: the issue and whether it is drawn on a card. */
export interface MetaChipsProps {
  issue: OrderedIssueRead;
  /** True on a board card, where the chips wrap under the title. */
  card?: boolean;
}

/**
 * The chips after the title: sub-issue progress, labels, pull requests,
 * project, cycle, estimate and dates, each only when the view shows it and
 * the issue has it, then the SLA countdown whenever the issue's team SLA
 * covers it.
 */
export const MetaChips: React.FC<MetaChipsProps> = ({
  issue,
  card = false,
}) => {
  const { slug, state, context, teamNameFor, filterFor } = useIssueViewEnv();
  const filterLabel = filterFor?.('label');
  const filterEstimate = filterFor?.('estimate');
  const keyPrefix = issue.key.split('-')[0] ?? '';
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
        labels.slice(0, LABELS_SHOWN).map((label) =>
          filterLabel === undefined ? (
            <LabelChip
              key={label.id}
              color={label.color}
              name={label.name}
              className={cn('max-w-32', hide)}
            />
          ) : (
            <FilterChipButton
              key={label.id}
              tooltip={`Filter by label: ${label.name}`}
              onFilter={() => {
                filterLabel(label.id);
              }}
              wrapperClassName={hide}
              className="rounded-full"
            >
              <LabelChip
                color={label.color}
                name={label.name}
                className="max-w-32 hover:border-line-strong"
              />
            </FilterChipButton>
          )
        )}
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
      {shows('pull_requests') && (
        <PullRequestChip issue={issue} className={hide} />
      )}
      {shows('project') && project !== undefined && (
        <NavChipLink
          tooltip={`Open project: ${project.name}`}
          to={projectPath(slug, project.project_id, keyPrefix)}
          wrapperClassName={card ? '' : 'hidden lg:inline-flex'}
          className={CHIP_CLASS}
        >
          <LuBox aria-hidden="true" className="h-3 w-3" />
          <span className="truncate">{project.name}</span>
        </NavChipLink>
      )}
      {shows('cycle') && cycle !== undefined && (
        <NavChipLink
          tooltip={`Open cycle: ${cycle.name}`}
          to={cyclePath(slug, keyPrefix, cycle.cycle_id)}
          wrapperClassName={card ? '' : 'hidden lg:inline-flex'}
          className={CHIP_CLASS}
        >
          <LuIterationCw aria-hidden="true" className="h-3 w-3" />
          <span className="truncate">{cycle.name}</span>
        </NavChipLink>
      )}
      {shows('estimate') &&
        issue.estimate !== null &&
        (filterEstimate === undefined ? (
          <Chip
            label="Estimate"
            icon={<LuTriangle aria-hidden="true" className="h-3 w-3" />}
            className={hide}
          >
            {issue.estimate}
          </Chip>
        ) : (
          <FilterChipButton
            tooltip={`Filter by estimate: ${issue.estimate}`}
            onFilter={() => {
              if (issue.estimate !== null) filterEstimate(issue.estimate);
            }}
            wrapperClassName={hide}
            className={CHIP_CLASS}
          >
            <LuTriangle aria-hidden="true" className="h-3 w-3" />
            <span className="truncate">{issue.estimate}</span>
          </FilterChipButton>
        ))}
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
      <SlaBadge issue={issue} className={hide} />
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
