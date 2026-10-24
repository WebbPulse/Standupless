/**
 * The project overview's activity: who changed the project's properties and
 * milestones, interleaved with the updates posted on it, newest first, in the
 * compact rows the issue timeline uses.
 *
 * While either list has older pages unread, entries older than its oldest
 * loaded row are held back, so the feed never shows a gap that a later page
 * would fill. "Show more" reveals the held rows and reads the next page.
 */

import React, { useMemo, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuCalendar,
  LuCirclePlus,
  LuLayers,
  LuMessageSquare,
  LuMilestone,
  LuPencil,
  LuSignalHigh,
  LuTarget,
  LuUserRound,
  LuUsers,
} from 'react-icons/lu';
import { useProjectActivity } from '../../hooks/useProjectActivity';
import { viaLabel } from '../../lib/changeSource';
import { errorMessage } from '../../lib/errors';
import { actorLabel, avatarOf, type Assignable } from '../../lib/issuePeople';
import {
  describeProjectActivity,
  type ProjectActivityIcon,
  type ProjectActivityLookups,
  type ProjectActivityPart,
} from '../../lib/projectActivityDisplay';
import { PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import type {
  ChangeSource,
  ProjectActivityRead,
  ProjectUpdateRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Avatar from '../ui/avatar';
import { Button } from '../ui/button';
import RelativeTime from '../ui/relative-time';
import Skeleton from '../ui/skeleton';
import { ProjectHealthGlyph } from './ProjectHealthGlyph';
import { ProjectStatusGlyph } from './ProjectStatusGlyph';

/** How many entries show before "Show more". */
const INITIAL_ROWS = 10;

/** How many more entries each "Show more" reveals. */
const MORE_ROWS = 20;

const ICONS: Record<ProjectActivityIcon, IconType> = {
  created: LuCirclePlus,
  name: LuPencil,
  status: LuLayers,
  health: LuTarget,
  priority: LuSignalHigh,
  lead: LuUserRound,
  members: LuUsers,
  date: LuCalendar,
  teams: LuUsers,
  initiative: LuTarget,
  milestone: LuMilestone,
};

/** Props for ProjectActivityFeed. */
export interface ProjectActivityFeedProps {
  workspaceId: string;
  projectId: string;
  people: Assignable[];
  teams: ProjectActivityLookups['teams'];
  initiatives: ProjectActivityLookups['initiatives'];
  milestones: ProjectActivityLookups['milestones'];
  /** The project's updates loaded so far, newest first. */
  updates: ProjectUpdateRead[];
  /** Whether older updates are still unread. */
  updatesHaveMore: boolean;
  onLoadMoreUpdates: () => void;
  /** Opens the updates tab. */
  onOpenUpdates: () => void;
}

/** One entry of the merged feed. */
type FeedEntry =
  | { kind: 'activity'; id: string; at: string; row: ProjectActivityRead }
  | { kind: 'update'; id: string; at: string; update: ProjectUpdateRead };

/** The oldest timestamp a list has loaded, or null when it is empty. */
const oldestOf = (rows: { created_at: string }[]): string | null =>
  rows.length === 0 ? null : (rows[rows.length - 1]?.created_at ?? null);

/** The "via MCP" suffix, when the change came through a client. */
const Via: React.FC<{ source: ChangeSource | null | undefined }> = ({
  source,
}) => {
  const label = viaLabel(source);
  if (label === null) return null;
  return <span className="text-text-faint"> {label}</span>;
};

/** One piece of a sentence. */
const Part: React.FC<{ part: ProjectActivityPart }> = ({ part }) => {
  if (part.kind === 'text') return <>{part.text}</>;
  if (part.kind === 'status') {
    return (
      <span className="inline-flex items-center gap-1 align-middle font-medium text-text">
        <ProjectStatusGlyph status={part.status} className="h-3 w-3" />
        {part.text}
      </span>
    );
  }
  if (part.kind === 'health') {
    return (
      <span className="inline-flex items-center gap-1 align-middle font-medium text-text">
        <ProjectHealthGlyph health={part.health} className="h-3 w-3" />
        {part.text}
      </span>
    );
  }
  return <span className="font-medium text-text">{part.text}</span>;
};

/** The shared frame of one row: the glyph, the sentence and its time. */
const Row: React.FC<{
  glyph: React.ReactNode;
  actor: string;
  source: ChangeSource | null | undefined;
  at: string;
  children: React.ReactNode;
}> = ({ glyph, actor, source, at, children }) => (
  <li className="relative flex min-h-7 items-center gap-3">
    <span className="relative z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg">
      {glyph}
    </span>
    <p className="min-w-0 flex-1 truncate text-xs text-text-muted">
      <span className="font-medium text-text">{actor}</span> {children}
      <Via source={source} />
      <span className="text-text-faint"> · </span>
      <RelativeTime value={at} />
    </p>
  </li>
);

/** A recorded property or milestone change. */
const ActivityRow: React.FC<{
  row: ProjectActivityRead;
  lookups: ProjectActivityLookups;
}> = ({ row, lookups }) => {
  const actor = actorLabel('user', row.actor_id, lookups.people);
  const description = describeProjectActivity(row, lookups);
  const Icon = ICONS[description.icon];
  const glyph =
    description.icon === 'created' ? (
      <Avatar
        name={actor}
        src={avatarOf(row.actor_id, lookups.people)}
        size="xs"
      />
    ) : (
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-text-faint" />
    );
  return (
    <Row glyph={glyph} actor={actor} source={row.source} at={row.created_at}>
      {description.parts.map((part, place) => (
        <Part key={`${String(place)}-${part.text}`} part={part} />
      ))}
    </Row>
  );
};

/** A posted update, which opens the updates tab. */
const UpdateRow: React.FC<{
  update: ProjectUpdateRead;
  people: Assignable[];
  onOpen: () => void;
}> = ({ update, people, onOpen }) => (
  <Row
    glyph={
      <LuMessageSquare
        aria-hidden="true"
        className="h-3.5 w-3.5 text-text-faint"
      />
    }
    actor={actorLabel('user', update.author_id, people)}
    source={update.source}
    at={update.created_at}
  >
    <button
      type="button"
      onClick={onOpen}
      className="rounded-sm text-text-muted underline-offset-2 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      posted an update
    </button>{' '}
    <Part
      part={{
        kind: 'health',
        health: update.health,
        text: PROJECT_HEALTH_LABELS[update.health],
      }}
    />
  </Row>
);

/** Reads the project's activity and renders it with the updates as one feed. */
export const ProjectActivityFeed: React.FC<ProjectActivityFeedProps> = ({
  workspaceId,
  projectId,
  people,
  teams,
  initiatives,
  milestones,
  updates,
  updatesHaveMore,
  onLoadMoreUpdates,
  onOpenUpdates,
}) => {
  const feed = useProjectActivity(workspaceId, projectId);
  const [limit, setLimit] = useState(INITIAL_ROWS);

  const lookups = useMemo<ProjectActivityLookups>(
    () => ({ people, teams, initiatives, milestones }),
    [people, teams, initiatives, milestones]
  );

  const entries = useMemo<FeedEntry[]>(() => {
    const cutoff = [
      feed.hasMore ? oldestOf(feed.activity) : null,
      updatesHaveMore ? oldestOf(updates) : null,
    ].reduce<string | null>(
      (latest, value) =>
        value !== null && (latest === null || value > latest) ? value : latest,
      null
    );
    const merged: FeedEntry[] = [
      ...feed.activity.map((row): FeedEntry => ({
        kind: 'activity',
        id: `activity-${row.activity_id}`,
        at: row.created_at,
        row,
      })),
      ...updates.map((update): FeedEntry => ({
        kind: 'update',
        id: `update-${update.update_id}`,
        at: update.created_at,
        update,
      })),
    ];
    return merged
      .filter((entry) => cutoff === null || entry.at >= cutoff)
      .sort((left, right) =>
        left.at < right.at ? 1 : left.at > right.at ? -1 : 0
      );
  }, [feed.activity, feed.hasMore, updates, updatesHaveMore]);

  const shown = entries.slice(0, limit);
  const hasMore = entries.length > limit || feed.hasMore || updatesHaveMore;

  const showMore = (): void => {
    setLimit((current) => current + MORE_ROWS);
    if (entries.length <= limit + MORE_ROWS) {
      if (feed.hasMore) feed.loadMore();
      if (updatesHaveMore) onLoadMoreUpdates();
    }
  };

  return (
    <section aria-labelledby="project-activity">
      <h2 id="project-activity" className="mb-2 text-sm font-medium text-text">
        Activity
      </h2>
      {feed.error !== null && (
        <ErrorAlert
          message={errorMessage(feed.error, 'Could not load the activity.')}
        />
      )}
      {feed.isLoading && entries.length === 0 ? (
        <div className="space-y-2" aria-label="Loading activity">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : entries.length === 0 ? (
        <p className="text-xs text-text-muted">No activity yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((entry) =>
            entry.kind === 'activity' ? (
              <ActivityRow key={entry.id} row={entry.row} lookups={lookups} />
            ) : (
              <UpdateRow
                key={entry.id}
                update={entry.update}
                people={people}
                onOpen={onOpenUpdates}
              />
            )
          )}
        </ul>
      )}
      {hasMore && entries.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1"
          disabled={feed.isPaging}
          onClick={showMore}
        >
          {feed.isPaging ? 'Loading' : 'Show more'}
        </Button>
      )}
    </section>
  );
};

export default ProjectActivityFeed;
