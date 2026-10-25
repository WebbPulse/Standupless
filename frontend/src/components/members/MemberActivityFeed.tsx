/**
 * A member's recent issue changes and comments, newest first, a page at a
 * time behind "Load more". Each row names the issue it touched and links to
 * it. The feed takes the read from {@link useMemberActivity}, so any page that
 * shows one person's activity, the caller's own included, draws it the same.
 */

import React, { useMemo } from 'react';
import { LuMessageSquare } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import type { MemberActivity } from '../../hooks/useMemberActivity';
import { useIssueContext } from '../../hooks/useIssueContext';
import {
  describeActivity,
  type ActivityContext,
} from '../../lib/activityDisplay';
import { errorMessage } from '../../lib/errors';
import { issuePath } from '../../lib/paths';
import type { MemberActivityRead } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import Button from '../ui/button';
import EmptyState from '../ui/empty-state';
import RelativeTime from '../ui/relative-time';
import { SkeletonRows } from '../ui/skeleton';

/** Props for MemberActivityFeed: the read, the person and where links go. */
export interface MemberActivityFeedProps {
  feed: MemberActivity;
  workspaceId: string;
  slug: string;
  /** The member's name as the rows lead with it. */
  name: string;
  avatarUrl?: string | null;
  emptyMessage?: string;
}

/** The sentence a row reads after the member's name. */
const sentence = (
  row: MemberActivityRead,
  context: ActivityContext
): string => {
  if (
    row.type === 'comment' ||
    row.activity === null ||
    row.activity === undefined
  ) {
    return 'commented on';
  }
  return `${describeActivity(row.activity, context).text} on`;
};

/** One row: who, what, which issue and when. */
const FeedRow: React.FC<{
  row: MemberActivityRead;
  context: ActivityContext;
  slug: string;
  name: string;
  avatarUrl: string | null;
}> = ({ row, context, slug, name, avatarUrl }) => (
  <li className="flex gap-3 py-2.5">
    <span className="mt-0.5 shrink-0">
      <Avatar name={name} src={avatarUrl} size="sm" />
    </span>
    <div className="min-w-0 flex-1">
      <p className="text-sm text-text-muted">
        <span className="font-medium text-text">{name}</span>{' '}
        {sentence(row, context)}{' '}
        <Link
          to={issuePath(slug, row.issue_key)}
          className="font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <span className="font-mono text-xs text-text-faint">
            {row.issue_key}
          </span>{' '}
          {row.issue_title}
        </Link>
        <span className="text-text-faint"> · </span>
        <RelativeTime value={row.created_at} className="text-text-faint" />
      </p>
      {row.type === 'comment' &&
        row.comment !== null &&
        row.comment !== undefined &&
        row.comment.body !== '' && (
          <p className="mt-1 flex gap-1.5 text-sm text-text-muted">
            <LuMessageSquare
              aria-hidden="true"
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-faint"
            />
            <span className="line-clamp-3 break-words whitespace-pre-line">
              {row.comment.body}
            </span>
          </p>
        )}
    </div>
  </li>
);

/** The feed of one member's activity. */
export const MemberActivityFeed: React.FC<MemberActivityFeedProps> = ({
  feed,
  workspaceId,
  slug,
  name,
  avatarUrl = null,
  emptyMessage = 'No recent activity.',
}) => {
  const teamIds = useMemo(
    () => [...new Set(feed.activity.map((row) => row.team_id))],
    [feed.activity]
  );
  const { context: lists } = useIssueContext(workspaceId, teamIds);
  const context = useMemo<ActivityContext>(
    () => ({
      statuses: lists.statuses,
      people: lists.people,
      labels: lists.labels.map((label) => ({ id: label.id, name: label.name })),
      issues: feed.activity.map((row) => ({
        id: row.issue_id,
        key: row.issue_key,
      })),
      projects: lists.projects.map((project) => ({
        id: project.project_id,
        name: project.name,
      })),
      cycles: lists.cycles.map((cycle) => ({
        id: cycle.cycle_id,
        name: cycle.name,
      })),
    }),
    [lists, feed.activity]
  );

  if (
    feed.error !== null &&
    feed.error !== undefined &&
    feed.activity.length === 0
  ) {
    return (
      <ErrorAlert
        message={errorMessage(feed.error, 'Could not load the activity.')}
      />
    );
  }
  if (feed.isLoading && feed.activity.length === 0) {
    return <SkeletonRows label="Loading activity" />;
  }
  if (feed.activity.length === 0) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <ol aria-label="Activity" className="divide-y divide-line">
        {feed.activity.map((row) => (
          <FeedRow
            key={row.id}
            row={row}
            context={context}
            slug={slug}
            name={name}
            avatarUrl={avatarUrl}
          />
        ))}
      </ol>
      {feed.hasMore && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            size="sm"
            disabled={feed.isPaging}
            onClick={feed.loadMore}
          >
            {feed.isPaging ? 'Loading' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
};

export default MemberActivityFeed;
