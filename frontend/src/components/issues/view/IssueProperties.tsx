/**
 * The properties an issue shows on a list row or a board card. Priority,
 * status and assignee are inline pickers that write optimistically, since
 * those are what people change while scanning a list; the rest are compact
 * chips, changed from the keyboard or the issue itself. Each respects the
 * view's visible properties, so hiding a property hides it everywhere.
 *
 * Chips act on a click: a project or cycle chip opens its page. For a person
 * who can edit, the label, estimate and date chips open their pickers in
 * place, as the glyphs do. Where a person cannot edit, the label and estimate
 * chips and the priority, status and assignee glyphs narrow the view to their
 * value instead, and the date chips stay inert.
 */

import React from 'react';
import {
  LuBox,
  LuCalendar,
  LuCalendarClock,
  LuIterationCw,
  LuLink,
  LuCircleDashed,
  LuRocket,
  LuTriangle,
} from 'react-icons/lu';
import { NONE, type OrderedIssueRead } from '../../../api/issues';
import { useTriageOn } from '../../../hooks/useTriageTeams';
import { cn } from '../../../lib/cn';
import { PRIORITY_LABELS } from '../../../lib/issueDisplay';
import { personAvatar, personLabel } from '../../../lib/issuePeople';
import {
  labelsOf,
  milestoneOf,
  releasesOf,
  type FilterField,
  type IssueRelease,
} from '../../../lib/issueView';
import { pullRequestChipStyle } from '../../../lib/pullRequestState';
import { cyclePath, projectPath } from '../../../lib/paths';
import { shortDateLabel } from '../../../lib/propertyOptions';
import { fullTimestamp } from '../../../lib/relativeTime';
import { compactDuration, enteredStatusAt } from '../../../lib/timeInStatus';
import { shownStatusId, triageStatusFor } from '../../../lib/triageStatus';
import { isPastDue } from '../../../lib/viewerTimezone';
import Avatar from '../../ui/avatar';
import { LabelChip } from '../../ui/badge';
import { PriorityGlyph } from '../../ui/glyphs';
import { StatusIcon } from '../../ui/StatusIcon';
import MilestoneGlyph from '../../planning/MilestoneGlyph';
import type { PopoverTriggerProps } from '../../ui/popover';
import { Tooltip } from '../../ui/tooltip';
import {
  CHIP_ACTION_CLASS,
  FilterChipButton,
  NavChipLink,
} from '../ChipActions';
import SlaBadge from '../SlaBadge';
import {
  AssigneePicker,
  DatePicker,
  EstimatePicker,
  LabelsPicker,
  PriorityPicker,
  StatusPicker,
} from '../PropertyPickers';
import { useIssueViewEnv } from './IssueViewContext';
import { SubIssueProgressChip } from './SubIssueCues';

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
  const triageOn = useTriageOn(issue.team_id);
  const shown = shownStatusId(issue);
  if (onFilter !== undefined) {
    const statuses = forTeam(issue.team_id).statuses;
    const status =
      issue.in_triage === true
        ? triageStatusFor()
        : statuses.find((item) => item.id === issue.status_id);
    return (
      <FilterChipButton
        tooltip={`Filter by status: ${status?.name ?? 'Unknown status'}`}
        onFilter={() => {
          onFilter(shown);
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
      triage={triageOn}
      value={shown}
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

/** Props for ChipTrigger: the popover wiring, its name and the chips drawn. */
interface ChipTriggerProps {
  trigger: PopoverTriggerProps;
  label: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * A row chip that opens a picker. The press stays on the chip, so neither the
 * issue under it nor the list's own Enter opens, and on a touch screen taps
 * pass through to the row as they do for the glyphs.
 */
const ChipTrigger: React.FC<ChipTriggerProps> = ({
  trigger,
  label,
  children,
  className,
}) => (
  <button
    type="button"
    aria-label={label}
    aria-haspopup={trigger['aria-haspopup']}
    aria-expanded={trigger['aria-expanded']}
    aria-controls={trigger['aria-controls']}
    draggable={false}
    onClick={(event) => {
      event.stopPropagation();
      event.preventDefault();
      trigger.onClick();
    }}
    onKeyDown={(event) => {
      trigger.onKeyDown(event);
      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
    }}
    className={cn(ABOVE_LINK, CHIP_ACTION_CLASS, className)}
  >
    {children}
  </button>
);

/** Props for the chip pickers: the issue and the wrapper's classes. */
interface ChipPickerProps {
  issue: OrderedIssueRead;
  /** Classes for the wrapper, such as a breakpoint that hides the chips. */
  className: string;
}

/**
 * The issue's labels as chips that open the labels picker for its team, where
 * several labels toggle in one visit and a new one can be created.
 */
const LabelChipsPicker: React.FC<ChipPickerProps> = ({ issue, className }) => {
  const { update, forTeam, context, createLabel } = useIssueViewEnv();
  const labels = labelsOf(issue, context);
  const own = forTeam(issue.team_id).labels;
  const names = labels.map((label) => label.name).join(', ');
  return (
    <span className={cn('shrink-0', className)}>
      <LabelsPicker
        labels={own}
        value={issue.label_ids}
        onCreate={(name) => createLabel(issue.team_id, name)}
        onChange={(next) => {
          const add = next.filter((id) => !issue.label_ids.includes(id));
          const remove = issue.label_ids.filter((id) => !next.includes(id));
          if (add.length === 0 && remove.length === 0) return;
          update([issue.id], {
            ...(add.length === 0 ? {} : { add_label_ids: add }),
            ...(remove.length === 0 ? {} : { remove_label_ids: remove }),
          });
        }}
        renderTrigger={(trigger) => (
          <ChipTrigger
            trigger={trigger}
            label={`Labels: ${names}`}
            className="inline-flex items-center gap-1.5 rounded-full"
          >
            {labels.slice(0, LABELS_SHOWN).map((label) => (
              <LabelChip
                key={label.id}
                color={label.color}
                name={label.name}
                className="max-w-32"
                reveal={false}
              />
            ))}
            {labels.length > LABELS_SHOWN && (
              <span className={CHIP_CLASS}>
                +{labels.length - LABELS_SHOWN}
              </span>
            )}
          </ChipTrigger>
        )}
      />
    </span>
  );
};

/** The issue's estimate as a chip opening the picker on its team's scale. */
const EstimateChipPicker: React.FC<ChipPickerProps> = ({
  issue,
  className,
}) => {
  const { update, scaleFor, estimateOptionsFor } = useIssueViewEnv();
  const options = estimateOptionsFor?.(issue.team_id) ?? {};
  return (
    <span className={cn('shrink-0', className)}>
      <EstimatePicker
        scale={scaleFor(issue.team_id)}
        extended={options.extended ?? false}
        allowZero={options.allowZero ?? false}
        value={issue.estimate}
        onChange={(estimate) => {
          update([issue.id], { estimate });
        }}
        renderTrigger={(trigger) => (
          <ChipTrigger
            trigger={trigger}
            label={`Estimate: ${issue.estimate ?? 'none'}`}
            className={CHIP_CLASS}
          >
            <LuTriangle aria-hidden="true" className="h-3 w-3" />
            <span className="truncate">{issue.estimate}</span>
          </ChipTrigger>
        )}
      />
    </span>
  );
};

/** Props for DateChipPicker: the chip pickers' props and which date. */
interface DateChipPickerProps extends ChipPickerProps {
  field: 'start_date' | 'due_date';
}

/**
 * One of the issue's dates as a chip opening the date picker. The start date
 * may not fall after the due date, nor the due date before the start, as on
 * the issue's own rail, and a past due date keeps its warning colour.
 */
const DateChipPicker: React.FC<DateChipPickerProps> = ({
  issue,
  field,
  className,
}) => {
  const { update } = useIssueViewEnv();
  const start = field === 'start_date';
  const value = start ? issue.start_date : issue.due_date;
  if (value === null) return null;
  const name = start ? 'Start date' : 'Due date';
  const min = start ? null : issue.start_date;
  const max = start ? issue.due_date : null;
  return (
    <span className={cn('shrink-0', className)}>
      <DatePicker
        field={name}
        value={value}
        {...(min === null ? {} : { min })}
        {...(max === null ? {} : { max })}
        onChange={(next) => {
          if (next === value) return;
          update([issue.id], start ? { start_date: next } : { due_date: next });
        }}
        renderTrigger={(trigger) => (
          <ChipTrigger
            trigger={trigger}
            label={`${name}: ${shortDateLabel(value)}`}
            className={cn(
              CHIP_CLASS,
              !start && isPastDue(value) && 'border-danger/40 text-danger'
            )}
          >
            {start ? (
              <LuCalendarClock aria-hidden="true" className="h-3 w-3" />
            ) : (
              <LuCalendar aria-hidden="true" className="h-3 w-3" />
            )}
            <span className="truncate">{shortDateLabel(value)}</span>
          </ChipTrigger>
        )}
      />
    </span>
  );
};

/** A timestamp as a short day. */
const dayOf = (value: string): string => shortDateLabel(value.slice(0, 10));

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

/**
 * The releases an issue shipped in as one chip: the newest release's name and
 * a count of the rest. Hovering names each one, with its stage where the chip
 * cannot filter, and a click narrows the view to the newest release where the
 * list offers that filter.
 */
export const ReleaseChip: React.FC<{
  releases: readonly IssueRelease[];
  className?: string;
}> = ({ releases, className }) => {
  const { filterFor } = useIssueViewEnv();
  const filterRelease = filterFor?.('release');
  const [lead] = releases;
  if (lead === undefined) return null;
  const rest = releases.length - 1;
  const lines = releases.map((release) =>
    release.stageName === undefined
      ? release.name
      : `${release.name} (${release.stageName})`
  );
  const body = (
    <>
      <LuRocket aria-hidden="true" className="h-3 w-3" />
      <span className="truncate">{lead.name}</span>
      {rest > 0 && (
        <span className="shrink-0 text-text-faint">+{String(rest)}</span>
      )}
    </>
  );
  if (filterRelease === undefined) {
    return (
      <span
        title={`Releases: ${lines.join(', ')}`}
        className={cn(CHIP_CLASS, 'max-w-40', className)}
      >
        {body}
      </span>
    );
  }
  return (
    <FilterChipButton
      tooltip={
        rest > 0
          ? `Filter by release: ${lead.name}, also in ${lines.slice(1).join(', ')}`
          : `Filter by release: ${lead.name}`
      }
      onFilter={() => {
        filterRelease(lead.id);
      }}
      wrapperClassName={cn(className)}
      className={cn(CHIP_CLASS, 'max-w-40')}
    >
      {body}
    </FilterChipButton>
  );
};

/** Props for MetaChips: the issue and whether it is drawn on a card. */
export interface MetaChipsProps {
  issue: OrderedIssueRead;
  /** True on a board card, where the chips wrap under the title. */
  card?: boolean;
  /** False where the row draws the sub-issue chip beside its title instead. */
  withProgress?: boolean;
}

/**
 * The chips after the title: sub-issue progress, labels, pull requests,
 * project, milestone, cycle, releases, relation count, estimate and dates, each only when the view shows it and
 * the issue has it, then the SLA countdown whenever the issue's team SLA
 * covers it.
 */
export const MetaChips: React.FC<MetaChipsProps> = ({
  issue,
  card = false,
  withProgress = true,
}) => {
  const { slug, state, context, teamNameFor, filterFor, milestones, canEdit } =
    useIssueViewEnv();
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
  const milestone = shows('milestone')
    ? milestoneOf(issue, milestones ? { ...context, milestones } : context)
    : undefined;
  const links = issue.relation_count ?? 0;
  const releases = shows('release') ? releasesOf(issue, context) : [];
  const teamName = teamNameFor?.(issue.team_id);
  const hide = card ? '' : 'hidden md:inline-flex';

  return (
    <>
      {withProgress && shows('sub_issues') && issue.progress.total > 0 && (
        <SubIssueProgressChip progress={issue.progress} className={hide} />
      )}
      {canEdit && shows('labels') && labels.length > 0 && (
        <LabelChipsPicker
          issue={issue}
          className={card ? 'inline-flex' : hide}
        />
      )}
      {!canEdit &&
        shows('labels') &&
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
                reveal={false}
              />
            </FilterChipButton>
          )
        )}
      {!canEdit && shows('labels') && labels.length > LABELS_SHOWN && (
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
          to={projectPath(slug, project, keyPrefix)}
          wrapperClassName={card ? '' : 'hidden lg:inline-flex'}
          className={CHIP_CLASS}
        >
          <LuBox aria-hidden="true" className="h-3 w-3" />
          <span className="truncate">{project.name}</span>
        </NavChipLink>
      )}
      {shows('milestone') && milestone !== undefined && (
        <Chip
          label={`Milestone: ${milestone.name}`}
          icon={<MilestoneGlyph milestone={milestone} size={12} />}
          className={cn('max-w-40', card ? '' : 'hidden lg:inline-flex')}
        >
          {milestone.name}
        </Chip>
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
      {releases.length > 0 && (
        <ReleaseChip
          releases={releases}
          className={card ? '' : 'hidden lg:inline-flex'}
        />
      )}
      {shows('links') && links > 0 && (
        <Chip
          label={links === 1 ? '1 link' : `${String(links)} links`}
          icon={<LuLink aria-hidden="true" className="h-3 w-3" />}
          className={hide}
        >
          {links}
        </Chip>
      )}
      {canEdit && shows('estimate') && issue.estimate !== null && (
        <EstimateChipPicker
          issue={issue}
          className={card ? 'inline-flex' : hide}
        />
      )}
      {!canEdit &&
        shows('estimate') &&
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
      {canEdit && shows('start_date') && issue.start_date !== null && (
        <DateChipPicker
          issue={issue}
          field="start_date"
          className={card ? 'inline-flex' : hide}
        />
      )}
      {!canEdit && shows('start_date') && issue.start_date !== null && (
        <Chip
          label="Start date"
          icon={<LuCalendarClock aria-hidden="true" className="h-3 w-3" />}
          className={hide}
        >
          {shortDateLabel(issue.start_date)}
        </Chip>
      )}
      {canEdit && shows('due_date') && issue.due_date !== null && (
        <DateChipPicker
          issue={issue}
          field="due_date"
          className={card ? 'inline-flex' : hide}
        />
      )}
      {!canEdit && shows('due_date') && issue.due_date !== null && (
        <Chip
          label="Due date"
          icon={<LuCalendar aria-hidden="true" className="h-3 w-3" />}
          className={cn(
            hide,
            isPastDue(issue.due_date) && 'border-danger/40 text-danger'
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
      {shows('time_in_status') && (
        <span
          title={`In status since ${fullTimestamp(enteredStatusAt(issue))}`}
          className={cn('w-10 text-right text-2xs text-text-faint', hide)}
        >
          {compactDuration(enteredStatusAt(issue))}
        </span>
      )}
    </>
  );
};
