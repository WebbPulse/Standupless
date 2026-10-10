/**
 * The pieces the workspace home is drawn from: the section frame and the one
 * line rows for open pull requests, shipped issues, releases, cycles,
 * projects, project updates and inbox notifications, plus the setup
 * checklist a new workspace sees. Every row takes the same keyboard props an
 * issue row does, so j and k walk the whole page as one list.
 */

import React from 'react';
import {
  LuCalendarRange,
  LuCheck,
  LuChevronRight,
  LuCircleCheck,
  LuGithub,
  LuRocket,
  LuUserPlus,
  LuUsers,
} from 'react-icons/lu';
import { Link } from 'react-router-dom';
import ProgressBar from '../../../components/planning/ProgressBar';
import ProjectHealthGlyph from '../../../components/planning/ProjectHealthGlyph';
import ProjectStatusGlyph from '../../../components/planning/ProjectStatusGlyph';
import UpdateDueBadge from '../../../components/planning/UpdateDueBadge';
import { Kbd } from '../../../components/ui/badge';
import RelativeTime from '../../../components/ui/relative-time';
import { cn } from '../../../lib/cn';
import {
  completionPercent,
  daysRemainingLabel,
  shortCountsLabel,
} from '../../../lib/planningDisplay';
import {
  ciStateStyle,
  reviewStateStyle,
  type StatusStyle,
} from '../../../lib/pullRequestStacks';
import { pullRequestStateStyle } from '../../../lib/pullRequestState';
import type {
  CycleRead,
  HomePullRequestItem,
  HomeShippedItem,
  HomePulseItem,
  NotificationRead,
  ProjectRead,
  ReleaseRead,
} from '../../../types/Api';

/** The keyboard props every home row takes. */
export interface HomeRowProps {
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
}

/** The look of a one line row, matching an issue row's height and highlight. */
const rowClass = (isActive: boolean, tall = false): string =>
  cn(
    'relative flex items-center gap-2.5 border-b border-line px-4 text-sm transition-colors duration-100 last:border-b-0 hover:bg-surface',
    tall ? 'py-2.5' : 'h-row',
    isActive &&
      'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
  );

/** A section of the home with its heading row. */
export const HomeSection: React.FC<{
  id: string;
  title: string;
  count?: string | undefined;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, count, meta, action, children }) => (
  <section
    aria-labelledby={id}
    className="overflow-hidden rounded-md border border-line bg-bg"
  >
    <header className="flex h-9 items-center gap-2 border-b border-line bg-surface px-4">
      <h2 id={id} className="text-xs font-medium text-text">
        {title}
      </h2>
      {count !== undefined && (
        <span className="text-xs text-text-faint tabular-nums">{count}</span>
      )}
      {meta}
      <span className="flex-1" />
      {action}
    </header>
    {children}
  </section>
);

/** The small link a section heading carries to its full page. */
export const SectionLink: React.FC<{
  to: string;
  children: React.ReactNode;
}> = ({ to, children }) => (
  <Link
    to={to}
    className="inline-flex items-center gap-0.5 rounded-xs text-xs text-text-muted transition-colors hover:text-text"
  >
    {children}
    <LuChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>
);

/** The heading above one group of rows inside a section. */
export const GroupHeading: React.FC<{
  label: string;
  total: number;
  tone: 'danger' | 'warning' | 'neutral';
}> = ({ label, total, tone }) => (
  <li
    role="presentation"
    className="flex h-7 items-center gap-2 border-b border-line bg-bg px-4 text-2xs font-medium text-text-muted lg:px-6"
  >
    <span
      aria-hidden="true"
      className={cn(
        'h-1.5 w-1.5 rounded-full',
        tone === 'danger'
          ? 'bg-danger'
          : tone === 'warning'
            ? 'bg-warning'
            : 'bg-text-faint'
      )}
    />
    <span>{label}</span>
    <span className="text-text-faint tabular-nums">{total}</span>
  </li>
);

/** A quiet one or two line note for a section with nothing to show. */
export const SectionNote: React.FC<{
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ children, action }) => (
  <div className="flex items-center gap-3 px-4 py-3 text-xs text-text-muted">
    <span className="min-w-0 flex-1">{children}</span>
    {action}
  </div>
);

/** One issue completed this week. */
export const ShippedRow: React.FC<
  HomeRowProps & { item: HomeShippedItem; href: string; teamName?: string }
> = ({ item, href, teamName, isActive, rowRef, onPointerEnter }) => (
  <li
    ref={rowRef}
    aria-current={isActive ? 'true' : undefined}
    onPointerEnter={onPointerEnter}
    className={rowClass(isActive)}
  >
    <LuCircleCheck
      className="h-3.5 w-3.5 shrink-0 text-success"
      aria-hidden="true"
    />
    <span className="w-16 shrink-0 truncate text-xs text-text-faint tabular-nums">
      {item.issue.key}
    </span>
    <Link
      to={href}
      data-hover="parent"
      className="min-w-0 flex-1 truncate text-text after:absolute after:inset-0"
    >
      {item.issue.title}
    </Link>
    {teamName !== undefined && (
      <span className="hidden shrink-0 text-xs text-text-faint xl:inline">
        {teamName}
      </span>
    )}
    <RelativeTime
      value={item.completed_at}
      className="w-14 shrink-0 text-right text-xs text-text-faint"
    />
  </li>
);

/** One small review or check icon, named for screen readers. */
const StatusGlyph: React.FC<{ style: StatusStyle | null; kind: string }> = ({
  style,
  kind,
}) => {
  if (style === null) return null;
  const Icon = style.icon;
  return (
    <span
      role="img"
      aria-label={style.label}
      title={style.label}
      data-status={kind}
      className="inline-flex shrink-0"
    >
      <Icon
        aria-hidden="true"
        className={cn('h-3.5 w-3.5', style.colorClass)}
      />
    </span>
  );
};

/** An open pull request on the caller's work, with its review and checks. */
export const PullRequestRow: React.FC<
  HomeRowProps & { item: HomePullRequestItem; href: string }
> = ({ item, href, isActive, rowRef, onPointerEnter }) => {
  const pr = item.pull_request;
  const state = pullRequestStateStyle(pr.state);
  const StateIcon = state.icon;
  const repo = pr.repository_full_name.split('/').pop() ?? '';
  return (
    <li
      ref={rowRef}
      aria-current={isActive ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={rowClass(isActive)}
    >
      <StateIcon
        className={cn('h-3.5 w-3.5 shrink-0', state.colorClass)}
        aria-label={state.label}
        role="img"
      />
      <span className="w-16 shrink-0 truncate text-xs text-text-faint tabular-nums">
        {item.issue.key}
      </span>
      <Link
        to={href}
        data-hover="parent"
        className="min-w-0 flex-1 truncate text-text after:absolute after:inset-0"
      >
        {pr.title !== '' ? pr.title : item.issue.title}
      </Link>
      <StatusGlyph style={reviewStateStyle(pr.review_state)} kind="review" />
      <StatusGlyph style={ciStateStyle(pr.ci_state)} kind="ci" />
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="relative z-10 hidden shrink-0 text-xs text-text-faint tabular-nums hover:text-text sm:inline"
      >
        {`${repo}#${String(pr.number)}`}
      </a>
    </li>
  );
};

/** One release that reached its team's last stage this week. */
export const ReleaseRow: React.FC<
  HomeRowProps & {
    release: ReleaseRead;
    href: string | null;
    teamName: string;
  }
> = ({ release, href, teamName, isActive, rowRef, onPointerEnter }) => (
  <li
    ref={rowRef}
    aria-current={isActive ? 'true' : undefined}
    onPointerEnter={onPointerEnter}
    className={rowClass(isActive)}
  >
    <LuRocket className="h-3.5 w-3.5 shrink-0 text-merged" aria-hidden="true" />
    {href === null ? (
      <span className="min-w-0 flex-1 truncate text-text">{release.name}</span>
    ) : (
      <Link
        to={href}
        data-hover="parent"
        className="min-w-0 flex-1 truncate text-text after:absolute after:inset-0"
      >
        {release.name}
      </Link>
    )}
    <span className="hidden shrink-0 text-xs text-text-faint xl:inline">
      {teamName}
    </span>
    <span className="shrink-0 text-xs whitespace-nowrap text-text-faint tabular-nums">
      {release.issue_count === 1
        ? '1 issue'
        : `${String(release.issue_count)} issues`}
    </span>
    {release.current_stage != null && (
      <RelativeTime
        value={release.current_stage.reached_at}
        className="w-14 shrink-0 text-right text-xs text-text-faint"
      />
    )}
  </li>
);

/** One cycle running now, with its progress. */
export const CycleRow: React.FC<
  HomeRowProps & { cycle: CycleRead; href: string | null; teamName: string }
> = ({ cycle, href, teamName, isActive, rowRef, onPointerEnter }) => {
  const percent = completionPercent(cycle.counts);
  const name =
    cycle.name.trim() !== ''
      ? cycle.name
      : `Cycle ${String(cycle.number ?? '')}`.trim();
  const empty = cycle.counts.total === 0;
  return (
    <li
      ref={rowRef}
      aria-current={isActive ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={
        empty
          ? rowClass(isActive)
          : cn(rowClass(isActive, true), 'flex-col items-stretch gap-1.5')
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <LuCalendarRange
          className="h-3.5 w-3.5 shrink-0 text-text-faint"
          aria-hidden="true"
        />
        {href === null ? (
          <span className="min-w-0 flex-1 truncate font-medium text-text">
            {name}
          </span>
        ) : (
          <Link
            to={href}
            data-hover="parent"
            className="min-w-0 flex-1 truncate font-medium text-text after:absolute after:inset-0"
          >
            {name}
          </Link>
        )}
        <span className="shrink-0 text-xs text-text-faint">{teamName}</span>
        {empty && (
          <span className="shrink-0 text-xs whitespace-nowrap text-text-faint">
            {`No issues · ${daysRemainingLabel(cycle.end_date)}`}
          </span>
        )}
      </div>
      {!empty && (
        <>
          <div className="flex items-center gap-3">
            <ProgressBar percent={percent} className="flex-1" />
            <span className="w-9 shrink-0 text-right text-xs text-text-muted tabular-nums">
              {String(percent)}%
            </span>
          </div>
          <p className="flex gap-2 text-xs text-text-faint">
            <span className="truncate">{shortCountsLabel(cycle.counts)}</span>
            <span className="ml-auto shrink-0">
              {daysRemainingLabel(cycle.end_date)}
            </span>
          </p>
        </>
      )}
    </li>
  );
};

/** One project in flight: health, name, the stale flag and progress. */
export const ProjectRow: React.FC<
  HomeRowProps & { project: ProjectRead; href: string }
> = ({ project, href, isActive, rowRef, onPointerEnter }) => {
  const percent = completionPercent(project.counts);
  return (
    <li
      ref={rowRef}
      aria-current={isActive ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={rowClass(isActive)}
    >
      <ProjectStatusGlyph status={project.status} percent={percent} />
      <Link
        to={href}
        data-hover="parent"
        className="min-w-0 flex-1 truncate text-text after:absolute after:inset-0"
      >
        {project.name}
      </Link>
      <UpdateDueBadge project={project} className="relative shrink-0" />
      {project.health !== null && (
        <ProjectHealthGlyph health={project.health} />
      )}
      <span className="hidden shrink-0 text-right text-xs whitespace-nowrap text-text-faint 2xl:inline">
        {project.target_date === null
          ? ''
          : daysRemainingLabel(project.target_date)}
      </span>
      <span className="w-9 shrink-0 text-right text-xs text-text-muted tabular-nums">
        {String(percent)}%
      </span>
    </li>
  );
};

/** The newest written update on one project. */
export const PulseRow: React.FC<
  HomeRowProps & { item: HomePulseItem; href: string; author: string }
> = ({ item, href, author, isActive, rowRef, onPointerEnter }) => (
  <li
    ref={rowRef}
    aria-current={isActive ? 'true' : undefined}
    onPointerEnter={onPointerEnter}
    className={cn(rowClass(isActive, true), 'flex-col items-stretch gap-1')}
  >
    <div className="flex items-center gap-2">
      <ProjectHealthGlyph health={item.update.health} />
      <Link
        to={href}
        data-hover="parent"
        className="min-w-0 flex-1 truncate font-medium text-text after:absolute after:inset-0"
      >
        {item.project_name}
      </Link>
      <RelativeTime
        value={item.update.created_at}
        className="shrink-0 text-xs text-text-faint"
      />
    </div>
    <p className="line-clamp-2 text-xs text-text-muted">
      <span className="text-text-faint">{author}: </span>
      {item.update.body}
    </p>
  </li>
);

/** What a notification says happened, in a few words. */
const NOTIFICATION_VERBS: Partial<Record<NotificationRead['kind'], string>> = {
  assigned: 'assigned you',
  mentioned: 'mentioned you',
  commented: 'commented',
  status_changed: 'changed status',
  project_update: 'posted an update',
  project_update_due: 'Update due',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  standup_digest: 'Standup digest',
  sla_at_risk: 'SLA at risk',
  sla_breached: 'SLA breached',
};

/** One unread notification. */
export const InboxRow: React.FC<
  HomeRowProps & { item: NotificationRead; href: string }
> = ({ item, href, isActive, rowRef, onPointerEnter }) => {
  const verb = NOTIFICATION_VERBS[item.kind] ?? 'Notice';
  const fromPerson = /^[a-z]/.test(verb);
  const subject =
    item.issue_title !== ''
      ? item.issue_title
      : (item.project_name ?? item.issue_key);
  return (
    <li
      ref={rowRef}
      aria-current={isActive ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={cn(rowClass(isActive, true), 'flex-col items-stretch gap-0.5')}
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <Link
          to={href}
          data-hover="parent"
          className="min-w-0 flex-1 truncate text-text after:absolute after:inset-0"
        >
          {subject}
        </Link>
        <RelativeTime
          value={item.created_at}
          className="shrink-0 text-xs text-text-faint"
        />
      </div>
      <p className="truncate pl-3.5 text-xs text-text-faint">
        {fromPerson ? `${item.actor_name} ${verb}` : verb}
        {item.issue_key !== '' ? ` · ${item.issue_key}` : ''}
      </p>
    </li>
  );
};

/** One step of the new workspace checklist. */
export interface SetupStep {
  id: string;
  title: string;
  detail: string;
  done: boolean;
  icon: 'team' | 'invite' | 'github';
  action: React.ReactNode;
}

const STEP_ICONS: Record<SetupStep['icon'], React.ReactNode> = {
  team: <LuUsers className="h-4 w-4" aria-hidden="true" />,
  invite: <LuUserPlus className="h-4 w-4" aria-hidden="true" />,
  github: <LuGithub className="h-4 w-4" aria-hidden="true" />,
};

/** The steps a new workspace takes before the home has anything to show. */
export const SetupChecklist: React.FC<{ steps: SetupStep[] }> = ({ steps }) => {
  const done = steps.filter((step) => step.done).length;
  return (
    <HomeSection
      id="home-setup"
      title="Set up your workspace"
      count={`${String(done)} of ${String(steps.length)}`}
    >
      <ol>
        {steps.map((step) => (
          <li
            key={step.id}
            className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
          >
            <span
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border',
                step.done
                  ? 'border-success bg-success-soft text-success'
                  : 'border-line text-text-muted'
              )}
            >
              {step.done ? (
                <LuCheck className="h-4 w-4" aria-hidden="true" />
              ) : (
                STEP_ICONS[step.icon]
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'text-sm font-medium',
                  step.done ? 'text-text-faint line-through' : 'text-text'
                )}
              >
                {step.title}
                {step.done && <span className="sr-only"> (done)</span>}
              </p>
              <p className="text-xs text-text-muted">{step.detail}</p>
            </div>
            {!step.done && step.action}
          </li>
        ))}
      </ol>
    </HomeSection>
  );
};

/** The keys the home answers to, shown once under the page. */
export const KeyHints: React.FC = () => (
  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-text-faint">
    <span className="flex items-center gap-1">
      <Kbd>J</Kbd>
      <Kbd>K</Kbd> move
    </span>
    <span className="flex items-center gap-1">
      <Kbd>Shift</Kbd>
      <Kbd>J</Kbd>
      <Kbd>K</Kbd> next or previous section
    </span>
    <span className="flex items-center gap-1">
      <Kbd>Enter</Kbd> open
    </span>
    <span className="flex items-center gap-1">
      <Kbd>C</Kbd> new issue
    </span>
  </p>
);
