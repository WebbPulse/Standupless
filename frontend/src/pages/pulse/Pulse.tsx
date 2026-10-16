/**
 * The caller's Pulse, like Linear's: one centred feed of project and
 * initiative updates, health changes and completed milestones, newest first.
 * "For me" holds what the caller leads, is a member of, owns or follows, and
 * "Recent" everything they may read. Opening the page reads the feed, so the
 * entries that were new keep their dot for this visit while the sidebar badge
 * clears.
 */

import React, { useEffect, useRef, useState } from 'react';
import { LuActivity, LuFlag, LuGoal } from 'react-icons/lu';
import { Link } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { listPulse, markPulseRead } from '../../api/pulse';
import { HealthPill } from '../../components/planning/ProjectUpdateCard';
import ProjectIcon from '../../components/planning/ProjectIcon';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import Markdown from '../../components/ui/markdown';
import RelativeTime from '../../components/ui/relative-time';
import { SkeletonRows } from '../../components/ui/skeleton';
import ViaSource from '../../components/ui/via-source';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  initiativePath,
  projectUpdatesTabPath,
  projectPath,
} from '../../lib/paths';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { pulseCountKey, pulseKey } from '../../lib/queryKeys';
import type { PulseItemRead, PulseScope } from '../../types/Api';

/** How often the first page is read again while the page is open. */
const POLL_MS = 60000;

/** The feeds the page switches between, in the order the switch shows them. */
const SCOPES: { id: PulseScope; label: string }[] = [
  { id: 'for_me', label: 'For me' },
  { id: 'recent', label: 'Recent' },
];

/** What an empty feed says, per scope. */
const EMPTY_MESSAGES: Record<PulseScope, string> = {
  for_me:
    'No updates yet. Follow a project or initiative to see its updates here.',
  recent: 'No project or initiative updates yet.',
};

/** Where an entry's title links: the updates tab for an update, else the page. */
const entryHref = (slug: string, item: PulseItemRead): string => {
  if (item.subject_type === 'initiative' && item.initiative_id !== null) {
    const base = initiativePath(slug, item.initiative_id);
    return item.event_type === 'initiative_update'
      ? `${base}?tab=updates`
      : base;
  }
  if (item.project_id === null) return '';
  return item.event_type === 'project_update'
    ? projectUpdatesTabPath(slug, item.project_id)
    : projectPath(slug, item.project_id);
};

/** The name of what an entry is about. */
const subjectName = (item: PulseItemRead): string =>
  (item.subject_type === 'initiative'
    ? item.initiative_name
    : item.project_name) ?? 'Untitled';

/** The sentence after the actor's name, saying what happened. */
const describe = (item: PulseItemRead): string => {
  switch (item.event_type) {
    case 'project_update':
    case 'initiative_update':
      return 'posted an update';
    case 'project_health':
    case 'initiative_health':
      return item.health === null
        ? 'cleared the health'
        : `set the health to ${PROJECT_HEALTH_LABELS[item.health].toLowerCase()}`;
    case 'milestone_completed':
      return `completed ${item.milestone_name ?? 'a milestone'}`;
  }
};

/** One sentence saying who did what, for the line under the title and its label. */
const summary = (item: PulseItemRead): string => {
  if (item.actor_name !== '') return `${item.actor_name} ${describe(item)}`;
  if (item.event_type === 'milestone_completed') {
    return `${item.milestone_name ?? 'A milestone'} was completed`;
  }
  const sentence = describe(item);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
};

/** The mark beside what an entry is about: the project's own icon, or a goal. */
const SubjectMark: React.FC<{ item: PulseItemRead }> = ({ item }) =>
  item.subject_type === 'initiative' ? (
    <span
      aria-hidden="true"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm bg-raised text-text-muted"
    >
      <LuGoal className="h-3.5 w-3.5" />
    </span>
  ) : (
    <ProjectIcon icon={item.project_icon} color={item.project_color} />
  );

/** Props for PulseEntry. */
interface PulseEntryProps {
  item: PulseItemRead;
  slug: string;
}

/** One feed entry: what it is about, who did what and when, and the update itself. */
const PulseEntry: React.FC<PulseEntryProps> = ({ item, slug }) => {
  const actor = item.actor_name === '' ? null : item.actor_name;
  const href = entryHref(slug, item);
  const name = subjectName(item);
  const isUpdate =
    item.event_type === 'project_update' ||
    item.event_type === 'initiative_update';
  return (
    <article
      aria-label={`${name}: ${summary(item)}`}
      data-unread={item.unread ? 'true' : undefined}
      className="relative border-b border-line/60 px-4 py-4 last:border-b-0"
    >
      {item.unread && (
        <span
          role="img"
          aria-label="Unread"
          className="absolute top-5 left-1 h-1.5 w-1.5 rounded-full bg-accent"
        />
      )}
      <header className="flex min-w-0 items-center gap-2">
        <SubjectMark item={item} />
        {href === '' ? (
          <span className="truncate text-sm font-medium text-text">{name}</span>
        ) : (
          <Link
            to={href}
            className="truncate text-sm font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {name}
          </Link>
        )}
        {item.health !== null && <HealthPill health={item.health} />}
      </header>
      <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-text-muted">
        {actor !== null ? (
          <Avatar name={actor} size="xs" />
        ) : (
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-text-faint"
          >
            {item.event_type === 'milestone_completed' ? (
              <LuFlag className="h-3 w-3" />
            ) : (
              <LuActivity className="h-3 w-3" />
            )}
          </span>
        )}
        <span className="min-w-0 truncate">
          {actor !== null && (
            <span className="font-medium text-text">{actor}</span>
          )}
          {actor !== null ? ` ${describe(item)}` : summary(item)}
        </span>
        <span aria-hidden="true">·</span>
        <RelativeTime value={item.created_at} className="shrink-0" />
        <ViaSource source={item.source} />
        {item.edited_at !== null && (
          <span className="text-text-faint">(edited)</span>
        )}
      </div>
      {isUpdate && item.body !== null && item.body.trim() !== '' && (
        <Markdown
          source={item.body}
          density="compact"
          className="mt-3 text-sm text-text"
        />
      )}
    </article>
  );
};

/** Props for PulseFeed: the workspace and the scope it reads. */
interface PulseFeedProps {
  workspaceId: string;
  slug: string;
  scope: PulseScope;
}

/**
 * One scope's feed: the polled first page, older pages on request, and the
 * read marker moved once there is something unread. The page keys it on the
 * workspace and scope, so switching starts it afresh.
 */
const PulseFeed: React.FC<PulseFeedProps> = ({ workspaceId, slug, scope }) => {
  const auth = useQueryAuth();
  const [older, setOlder] = useState<PulseItemRead[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const markedFor = useRef<string | null>(null);

  const query = usePolledQuery(
    ({ signal }) => listPulse(workspaceId, { scope }, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: pulseKey(workspaceId, scope),
      auth,
    }
  );
  const first = query.data;

  useEffect(() => {
    if (first === null || workspaceId === '') return;
    if (!first.items.some((item) => item.unread)) return;
    const mark = first.items[0]?.event_id ?? '';
    if (markedFor.current === mark) return;
    markedFor.current = mark;
    markPulseRead(workspaceId).then(
      () => {
        invalidateQueries(pulseCountKey(workspaceId));
      },
      () => undefined
    );
  }, [first, workspaceId]);

  const nextCursor =
    cursor === undefined ? (first?.next_cursor ?? null) : cursor;
  const seen = new Set((first?.items ?? []).map((item) => item.event_id));
  const items = [
    ...(first?.items ?? []),
    ...older.filter((item) => !seen.has(item.event_id)),
  ];

  const loadMore = (): void => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    listPulse(workspaceId, { scope, cursor: nextCursor }).then(
      (page) => {
        setOlder((current) => [...current, ...page.items]);
        setCursor(page.next_cursor);
        setLoadingMore(false);
      },
      (failure: unknown) => {
        setMoreError(failure);
        setLoadingMore(false);
      }
    );
  };

  if (query.error !== null && first === null) {
    return (
      <div className="px-4 pt-3 lg:px-6">
        <ErrorAlert
          message={errorMessage(query.error, 'Could not load your Pulse.')}
        />
      </div>
    );
  }
  if (first === null) return <SkeletonRows label="Loading Pulse" />;
  if (items.length === 0) {
    return <EmptyState icon={<LuActivity />} message={EMPTY_MESSAGES[scope]} />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-2 py-4 sm:px-4">
        <section
          aria-label={SCOPES.find((option) => option.id === scope)?.label}
          className="rounded-lg border border-line bg-surface"
        >
          {items.map((item) => (
            <PulseEntry key={item.event_id} item={item} slug={slug} />
          ))}
        </section>
        {moreError !== null && (
          <div className="mt-3">
            <ErrorAlert
              message={errorMessage(moreError, 'Could not load more.')}
            />
          </div>
        )}
        {nextCursor !== null && (
          <div className="mt-3 flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? 'Loading' : 'Show older'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

/** The Pulse page. */
export const Pulse: React.FC = () => {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const [scope, setScope] = useState<PulseScope>('for_me');

  return (
    <WorkspaceShell
      title="Pulse"
      flush
      actions={
        <div
          role="group"
          aria-label="Show"
          className="flex items-center gap-0.5 rounded-md border border-line p-0.5"
        >
          {SCOPES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={scope === option.id}
              onClick={() => {
                setScope(option.id);
              }}
              className={cn(
                'rounded-sm px-2 py-0.5 text-xs transition-colors duration-100 pointer-coarse:px-3 pointer-coarse:py-2.5 focus-visible:outline-2 focus-visible:outline-accent',
                scope === option.id
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      <PulseFeed
        key={`${workspaceId}:${scope}`}
        workspaceId={workspaceId}
        slug={slug}
        scope={scope}
      />
    </WorkspaceShell>
  );
};

export default Pulse;
