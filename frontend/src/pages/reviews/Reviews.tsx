/**
 * The pull requests waiting on the signed in person as a reviewer, like
 * Linear's Reviews: one dense list grouped by where each pull request stands
 * for them, needs your review first, then changes requested, then approved.
 * Rows come from the caller's linked GitHub account, so a pull request shows
 * whether or not it names an issue, and the issues it does name are one key
 * away. j and k walk the rows, Enter opens the pull request on GitHub and o
 * opens its first linked issue.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { LuChevronRight, LuGitPullRequest } from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getReviews } from '../../api/reviews';
import { ErrorAlert } from '../../components/ui/alert';
import EmptyState from '../../components/ui/empty-state';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useShortcut } from '../../hooks/useShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { issuePath } from '../../lib/paths';
import {
  ciStateStyle,
  reviewStateStyle,
  type StatusStyle,
} from '../../lib/pullRequestStacks';
import { pullRequestStateStyle } from '../../lib/pullRequestState';
import { reviewsKey } from '../../lib/queryKeys';
import type { ReviewGroup, ReviewItemRead } from '../../types/Api';

/** How often the list is read again while the page is open. */
const POLL_MS = 60000;

/** Where a person links the GitHub account the list is matched on. */
const SECURITY_PATH = '/security';

/** The groups in the order they show, with the words each heading uses. */
const GROUPS: { group: ReviewGroup; label: string }[] = [
  { group: 'needs_review', label: 'Needs your review' },
  { group: 'changes_requested', label: 'Changes requested' },
  { group: 'approved', label: 'Approved' },
];

/** The dot each group heading carries. */
const GROUP_TONES: Record<ReviewGroup, string> = {
  needs_review: 'bg-warning',
  changes_requested: 'bg-danger',
  approved: 'bg-success',
};

/** Opens a pull request on GitHub in a new tab. */
const openPullRequest = (item: ReviewItemRead): void => {
  window.open(item.url, '_blank', 'noopener,noreferrer');
};

/** The repository name without its owner, as a row prints it. */
const shortRepository = (fullName: string): string =>
  fullName.split('/').pop() ?? fullName;

/** One small review or check icon, named for screen readers. */
const StatusGlyph: React.FC<{ style: StatusStyle | null; kind: string }> = ({
  style,
  kind,
}) => {
  if (style === null) return <span className="w-3.5 shrink-0" />;
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

/** Props for ReviewRow. */
interface ReviewRowProps {
  item: ReviewItemRead;
  slug: string;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
}

/** One dense row: the pull request, its linked issues, author, review, checks and age. */
const ReviewRow: React.FC<ReviewRowProps> = ({
  item,
  slug,
  isActive,
  rowRef,
  onPointerEnter,
}) => {
  const state = pullRequestStateStyle(item.state);
  const StateIcon = state.icon;
  const reference = `${shortRepository(item.repository_full_name)}#${String(item.number)}`;
  return (
    <li
      ref={rowRef}
      data-row-id={`${item.repository_id}#${String(item.number)}`}
      aria-current={isActive ? 'true' : undefined}
      onPointerEnter={onPointerEnter}
      className={cn(
        'group/row relative flex h-row items-center gap-2.5 border-b border-line/60 pr-3 pl-4 text-sm lg:pr-5',
        isActive
          ? 'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
          : 'hover:bg-surface'
      )}
    >
      <StateIcon
        role="img"
        aria-label={state.label}
        className={cn('h-3.5 w-3.5 shrink-0', state.colorClass)}
      />
      <span
        title={item.repository_full_name}
        className="w-24 shrink-0 truncate font-mono text-xs text-text-faint sm:w-32"
      >
        {reference}
      </span>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        data-hover="parent"
        className="min-w-0 flex-1 truncate font-medium text-text after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-accent"
      >
        {item.title}
      </a>
      {item.issues.length > 0 && (
        <span className="relative z-10 hidden shrink-0 items-center gap-1.5 md:flex">
          {item.issues.slice(0, 2).map((issue) => (
            <Link
              key={issue.issue_id}
              to={issuePath(slug, issue.key)}
              title={issue.title}
              className="rounded-xs font-mono text-xs text-text-muted hover:text-text"
            >
              {issue.key}
            </Link>
          ))}
          {item.issues.length > 2 && (
            <span className="text-xs text-text-faint">
              {`+${String(item.issues.length - 2)}`}
            </span>
          )}
        </span>
      )}
      <span className="hidden w-24 shrink-0 truncate text-right text-xs text-text-muted lg:inline">
        {item.author_login}
      </span>
      <StatusGlyph style={reviewStateStyle(item.review_state)} kind="review" />
      <StatusGlyph style={ciStateStyle(item.ci_state)} kind="ci" />
      {item.updated_at !== null ? (
        <RelativeTime
          value={item.updated_at}
          className="w-14 shrink-0 text-right"
        />
      ) : (
        <span className="w-14 shrink-0" />
      )}
    </li>
  );
};

/** A group's heading, which folds the group away like an issue list's. */
const GroupHeader: React.FC<{
  group: ReviewGroup;
  label: string;
  total: number;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ group, label, total, collapsed, onToggle }) => (
  <div className="sticky top-0 z-20 flex h-9 items-center gap-2 border-b border-line bg-surface pr-3 pl-2 transition-colors duration-100 hover:bg-raised lg:pr-5">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-sm focus-visible:outline-2 focus-visible:outline-accent"
    >
      <LuChevronRight
        aria-hidden="true"
        className={cn(
          'h-3.5 w-3.5 shrink-0 text-text-faint transition-transform duration-100',
          !collapsed && 'rotate-90'
        )}
      />
      <span
        aria-hidden="true"
        className={cn('h-2 w-2 shrink-0 rounded-full', GROUP_TONES[group])}
      />
      <span className="truncate font-medium text-text">{label}</span>
      <span className="text-xs text-text-faint tabular-nums">{total}</span>
    </button>
  </div>
);

/** The Reviews page. */
export const Reviews: React.FC = () => {
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const [collapsed, setCollapsed] = useState<ReadonlySet<ReviewGroup>>(
    () => new Set()
  );

  const query = usePolledQuery(
    ({ signal }) => getReviews(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: reviewsKey(workspaceId),
      auth,
    }
  );
  const reviews = query.data;

  const sections = useMemo(
    () =>
      GROUPS.map(({ group, label }) => ({
        group,
        label,
        items: (reviews?.items ?? []).filter((item) => item.group === group),
      })).filter((section) => section.items.length > 0),
    [reviews]
  );

  const visible = useMemo(
    () =>
      sections.flatMap((section) =>
        collapsed.has(section.group) ? [] : section.items
      ),
    [sections, collapsed]
  );

  const resetKey = visible
    .map((item) => `${item.repository_id}#${String(item.number)}`)
    .join(',');

  const activate = useCallback(
    (index: number) => {
      const item = visible[index];
      if (item !== undefined) openPullRequest(item);
    },
    [visible]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: visible.length,
    onActivate: activate,
    resetKey,
  });

  const active = activeIndex >= 0 ? visible[activeIndex] : undefined;
  const linked = active?.issues[0];

  useShortcut({
    keys: 'o',
    label: 'Open linked issue',
    group: 'Reviews',
    enabled: linked !== undefined,
    handler: () => {
      if (linked !== undefined) void navigate(issuePath(slug, linked.key));
    },
  });

  const toggle = (group: ReviewGroup): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const body = (): React.ReactNode => {
    if (query.error !== null && reviews === null) {
      return (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(query.error, 'Could not load your reviews.')}
          />
        </div>
      );
    }
    if (reviews === null) return <SkeletonRows label="Loading reviews" />;
    if (!reviews.github_linked) {
      return (
        <EmptyState
          icon={<LuGitPullRequest />}
          message="Link your GitHub account to see the pull requests waiting on your review."
          action={
            <Link
              to={SECURITY_PATH}
              className="text-sm font-medium text-accent hover:underline"
            >
              Link GitHub
            </Link>
          }
        />
      );
    }
    if (sections.length === 0) {
      return (
        <EmptyState
          icon={<LuGitPullRequest />}
          message="No pull requests are waiting on your review."
        />
      );
    }
    const starts = sections.map((_, at) =>
      sections
        .slice(0, at)
        .reduce(
          (total, section) =>
            total + (collapsed.has(section.group) ? 0 : section.items.length),
          0
        )
    );
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.map((section, at) => (
          <section key={section.group} aria-label={section.label}>
            <GroupHeader
              group={section.group}
              label={section.label}
              total={section.items.length}
              collapsed={collapsed.has(section.group)}
              onToggle={() => {
                toggle(section.group);
              }}
            />
            {!collapsed.has(section.group) && (
              <ul aria-label={section.label}>
                {section.items.map((item, offset) => {
                  const position = (starts[at] ?? 0) + offset;
                  return (
                    <ReviewRow
                      key={`${item.repository_id}#${String(item.number)}`}
                      item={item}
                      slug={slug}
                      isActive={position === activeIndex}
                      rowRef={registerItem(position)}
                      onPointerEnter={() => {
                        setActiveIndex(position);
                      }}
                    />
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
    );
  };

  return (
    <WorkspaceShell title="Reviews" flush>
      {body()}
    </WorkspaceShell>
  );
};

export default Reviews;
