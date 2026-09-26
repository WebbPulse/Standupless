/**
 * The issue's activity: every recorded change and every comment thread in one
 * list, oldest at the top and newest at the bottom, with the comment box below
 * the newest entry. Changes read as one short line with a glyph, the actor and
 * a relative time; runs of the same kind by the same actor, such as a push that
 * names the issue in several commits, collapse into one line that expands.
 *
 * Both lists are cursor paged newest first on the server. Comments are read to
 * the end, because a thread missing its root reads wrong; activity loads older
 * pages on request from the top, where older entries belong.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LuBox,
  LuCalendar,
  LuChevronDown,
  LuChevronRight,
  LuCircleDot,
  LuCirclePlus,
  LuFileText,
  LuGitCommitHorizontal,
  LuHash,
  LuLink2,
  LuListTree,
  LuNetwork,
  LuPencil,
  LuRefreshCcw,
  LuSignalHigh,
  LuTag,
  LuUserRound,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { Link } from 'react-router-dom';
import { appendComments, listComments } from '../../api/discussion';
import { appendActivity, listActivity } from '../../api/issues';
import { useCursorPages, type CursorPage } from '../../hooks/useCursorPages';
import {
  groupSentence,
  shortSha,
  type ActivityContext,
  type ActivityIcon,
  type ActivityPart,
} from '../../lib/activityDisplay';
import { errorMessage } from '../../lib/errors';
import { actorLabel, type Assignable } from '../../lib/issuePeople';
import {
  buildTimeline,
  commentAttachmentIds,
  type TimelineEvent,
  type TimelineGroup,
} from '../../lib/issueTimeline';
import { cyclePath, issuePath, projectPath } from '../../lib/paths';
import { activityKey, commentsKey } from '../../lib/queryKeys';
import type { ActivityRead, CommentRead } from '../../types/Api';
import CommentCard from '../discussion/CommentCard';
import CommentComposer from '../discussion/CommentComposer';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { StatusGlyph } from '../ui/glyphs';
import RelativeTime from '../ui/relative-time';
import Skeleton from '../ui/skeleton';

/** Gives each part of a sentence a key built from its place and content. */
const keyedParts = (
  parts: ActivityPart[]
): { id: string; part: ActivityPart }[] =>
  parts.map((part, place) => ({
    id: `${String(place)}-${part.type === 'text' ? part.value : part.id}`,
    part,
  }));

/** Props for IssueTimeline. */
export interface IssueTimelineProps {
  workspaceId: string;
  issueId: string;
  currentUserId: string;
  canComment: boolean;
  isAdmin: boolean;
  /** The lists entries resolve their ids against. */
  context: ActivityContext;
  /** The workspace slug and team key prefix, to link what entries name. */
  slug: string;
  teamKeyPrefix: string;
  /** Hears the attachment ids the loaded comments show, to keep them off the issue's own row. */
  onCommentAttachments?: (ids: Set<string>) => void;
}

/** How many rows one page asks for. */
const PAGE_SIZE = 50;

/** How often the newest page of each list is re-read. */
const ACTIVITY_POLL_MS = 60000;
const COMMENTS_POLL_MS = 20000;

/** The glyph each kind of entry is drawn with. */
const ICONS: Record<ActivityIcon, IconType> = {
  created: LuCirclePlus,
  status: LuCircleDot,
  assignee: LuUserRound,
  priority: LuSignalHigh,
  labels: LuTag,
  title: LuPencil,
  description: LuFileText,
  estimate: LuHash,
  date: LuCalendar,
  parent: LuListTree,
  cycle: LuRefreshCcw,
  project: LuBox,
  commit: LuGitCommitHorizontal,
  relation: LuLink2,
  child: LuNetwork,
  other: LuPencil,
};

/** The glyph column every event row shares, lined up with the comment avatars. */
const Glyph: React.FC<{
  icon: ActivityIcon;
  actor: string;
  human: boolean;
}> = ({ icon, actor, human }) => {
  if (human && (icon === 'created' || icon === 'assignee')) {
    return <Avatar name={actor} size="xs" />;
  }
  const Icon = ICONS[icon];
  return <Icon aria-hidden="true" className="h-3.5 w-3.5 text-text-faint" />;
};

/** Where the entries link what they name. */
interface Linker {
  slug: string;
  teamKeyPrefix: string;
}

/** The class a named thing reads in, linked or not. */
const NAMED_CLASS = 'font-medium text-text';

/** One piece of an entry's sentence, linked where it names something. */
const Part: React.FC<{ part: ActivityPart; linker: Linker }> = ({
  part,
  linker,
}) => {
  if (part.type === 'text') return <>{part.value}</>;
  if (part.type === 'link') {
    return (
      <a
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${NAMED_CLASS} rounded-xs hover:underline`}
      >
        {part.name}
      </a>
    );
  }
  if (part.type === 'status') {
    return (
      <span className="inline-flex items-center gap-1 align-bottom">
        <StatusGlyph category={part.category} />
        <span className={NAMED_CLASS}>{part.name}</span>
      </span>
    );
  }
  const to =
    part.kind === 'project'
      ? projectPath(linker.slug, part.id)
      : part.kind === 'cycle' && linker.teamKeyPrefix !== ''
        ? cyclePath(linker.slug, linker.teamKeyPrefix, part.id)
        : part.kind === 'issue'
          ? issuePath(linker.slug, part.name)
          : null;
  if (to === null || linker.slug === '') {
    return <span className={NAMED_CLASS}>{part.name}</span>;
  }
  return (
    <Link to={to} className={`${NAMED_CLASS} rounded-xs hover:underline`}>
      {part.name}
    </Link>
  );
};

/** The short sha, linked to the commit when the push gave a URL. */
const CommitLink: React.FC<{ sha: string; url: string; message: string }> = ({
  sha,
  url,
  message,
}) => {
  const label = (
    <code className="font-mono text-xs text-text-muted">{shortSha(sha)}</code>
  );
  return (
    <>
      {url === '' ? (
        label
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-xs hover:underline"
        >
          {label}
        </a>
      )}
      {message !== '' && (
        <span className="truncate text-text-faint"> {message}</span>
      )}
    </>
  );
};

/** One event line. */
const EventRow: React.FC<{
  event: TimelineEvent;
  people: Assignable[];
  linker: Linker;
  nested?: boolean;
}> = ({ event, people, linker, nested = false }) => {
  const { entry, description } = event;
  const actor = actorLabel(entry.actor_kind, entry.actor_id, people);
  return (
    <li
      className={
        nested
          ? 'relative flex min-h-6 items-center gap-2'
          : 'relative flex min-h-7 items-center gap-3'
      }
    >
      <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg">
        <Glyph
          icon={description.icon}
          actor={actor}
          human={entry.actor_kind === 'user'}
        />
      </span>
      <p className="min-w-0 flex-1 truncate text-xs text-text-muted">
        <span className="font-medium text-text">{actor}</span>{' '}
        {keyedParts(description.parts).map(({ id, part }) => (
          <Part key={id} part={part} linker={linker} />
        ))}
        {description.commit !== undefined && (
          <>
            {' '}
            <CommitLink
              sha={description.commit.sha}
              url={description.commit.url}
              message={description.commit.message}
            />
          </>
        )}
        <span className="text-text-faint"> · </span>
        <RelativeTime value={entry.created_at} />
      </p>
    </li>
  );
};

/** A collapsed run, which expands to the entries inside it. */
const GroupRow: React.FC<{
  group: TimelineGroup;
  people: Assignable[];
  linker: Linker;
}> = ({ group, people, linker }) => {
  const [open, setOpen] = useState(false);
  const head = group.events[0];
  const tail = group.events[group.events.length - 1];
  if (head === undefined || tail === undefined) return null;
  const actor = actorLabel(head.entry.actor_kind, head.entry.actor_id, people);
  const Chevron = open ? LuChevronDown : LuChevronRight;
  return (
    <li className="relative">
      <div className="flex min-h-7 items-center gap-3">
        <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg">
          <Glyph
            icon={head.description.icon}
            actor={actor}
            human={head.entry.actor_kind === 'user'}
          />
        </span>
        <p className="min-w-0 flex-1 truncate text-xs text-text-muted">
          <span className="font-medium text-text">{actor}</span>{' '}
          {groupSentence(group.group, group.events.length)}{' '}
          <button
            type="button"
            aria-expanded={open}
            className="inline-flex items-center gap-0.5 rounded-xs text-text-faint hover:text-text"
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            <Chevron aria-hidden="true" className="h-3 w-3" />
            {open ? 'Hide' : 'Show'}
          </button>
          <span className="text-text-faint"> · </span>
          <RelativeTime value={tail.entry.created_at} />
        </p>
      </div>
      {open && (
        <ul className="mt-0.5 mb-1 ml-8 space-y-0.5">
          {group.events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              people={people}
              linker={linker}
              nested
            />
          ))}
        </ul>
      )}
    </li>
  );
};

/** Reads both lists and renders them as one timeline. */
export const IssueTimeline: React.FC<IssueTimelineProps> = ({
  workspaceId,
  issueId,
  currentUserId,
  canComment,
  isAdmin,
  context,
  slug,
  teamKeyPrefix,
  onCommentAttachments,
}) => {
  const linker = useMemo(
    () => ({ slug, teamKeyPrefix }),
    [slug, teamKeyPrefix]
  );
  const enabled = workspaceId !== '' && issueId !== '';

  const readActivity = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<ActivityRead>> => {
      const page = await listActivity(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.activity, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );

  const mergeActivity = useCallback(
    (held: ActivityRead[], incoming: ActivityRead[]): ActivityRead[] =>
      appendActivity(held, { activity: incoming, next_cursor: null }),
    []
  );

  const readComments = useCallback(
    async (
      cursor: string | undefined,
      signal?: AbortSignal
    ): Promise<CursorPage<CommentRead>> => {
      const page = await listComments(
        workspaceId,
        issueId,
        { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) },
        signal
      );
      return { rows: page.comments, nextCursor: page.next_cursor };
    },
    [workspaceId, issueId]
  );

  const mergeComments = useCallback(
    (held: CommentRead[], incoming: CommentRead[]): CommentRead[] =>
      appendComments(held, incoming),
    []
  );

  const activity = useCursorPages(readActivity, mergeActivity, {
    queryKey: activityKey(issueId),
    enabled,
    intervalMs: ACTIVITY_POLL_MS,
  });

  const comments = useCursorPages(readComments, mergeComments, {
    queryKey: commentsKey(issueId),
    enabled,
    intervalMs: COMMENTS_POLL_MS,
  });

  const {
    hasMore: moreComments,
    isPaging: pagingComments,
    isLoading: loadingComments,
    loadMore: loadMoreComments,
  } = comments;

  useEffect(() => {
    if (moreComments && !pagingComments && !loadingComments) {
      loadMoreComments();
    }
  }, [moreComments, pagingComments, loadingComments, loadMoreComments]);

  const items = useMemo(
    () => buildTimeline(activity.rows, comments.rows, context),
    [activity.rows, comments.rows, context]
  );

  useEffect(() => {
    onCommentAttachments?.(commentAttachmentIds(comments.rows));
  }, [comments.rows, onCommentAttachments]);

  const loading = activity.isLoading || comments.isLoading;

  return (
    <section aria-labelledby="activity-heading" className="space-y-4">
      <h2 id="activity-heading" className="text-sm font-semibold text-text">
        Activity
      </h2>

      {activity.error !== null && (
        <ErrorAlert
          message={errorMessage(activity.error, 'Could not load the activity.')}
        />
      )}
      {comments.error !== null && (
        <ErrorAlert
          message={errorMessage(comments.error, 'Could not load the comments.')}
        />
      )}

      {loading ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading activity"
          className="space-y-3"
        >
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3">
              <Skeleton className="h-5 w-5 shrink-0 rounded-full" />
              <Skeleton className={index === 1 ? 'h-3 w-1/2' : 'h-3 w-1/3'} />
            </div>
          ))}
        </div>
      ) : (
        <ol aria-label="Timeline" className="relative space-y-1">
          <span
            aria-hidden="true"
            className="absolute top-2 bottom-2 left-2.5 w-px bg-line"
          />
          {activity.hasMore && (
            <li className="relative flex min-h-7 items-center gap-3">
              <span className="relative z-10 h-5 w-5 shrink-0 rounded-full bg-bg" />
              <button
                type="button"
                disabled={activity.isPaging}
                className="rounded-xs text-xs text-text-faint hover:text-text disabled:opacity-50"
                onClick={activity.loadMore}
              >
                {activity.isPaging
                  ? 'Loading older activity'
                  : 'Show older activity'}
              </button>
            </li>
          )}
          {items.map((item) => {
            if (item.type === 'event') {
              return (
                <EventRow
                  key={item.id}
                  event={item}
                  people={context.people}
                  linker={linker}
                />
              );
            }
            if (item.type === 'group') {
              return (
                <GroupRow
                  key={item.id}
                  group={item}
                  people={context.people}
                  linker={linker}
                />
              );
            }
            return (
              <li key={item.id} className="relative z-10 py-2">
                <CommentCard
                  comment={item.comment}
                  replies={item.replies}
                  people={context.people}
                  workspaceId={workspaceId}
                  issueId={issueId}
                  currentUserId={currentUserId}
                  canComment={canComment}
                  isAdmin={isAdmin}
                />
              </li>
            );
          })}
        </ol>
      )}

      {canComment && (
        <CommentComposer
          workspaceId={workspaceId}
          issueId={issueId}
          people={context.people}
        />
      )}
    </section>
  );
};

export default IssueTimeline;
