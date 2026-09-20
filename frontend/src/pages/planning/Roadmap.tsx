/**
 * The workspace roadmap: every cycle and milestone the caller can see, by date
 * ascending with the undated entries last, drawn as bars on a month timeline.
 * There is no project list control that widens the read, only one that
 * narrows it: the server fans out over exactly the projects the caller's own
 * context allows, so a guest sees their projects and nothing else without this
 * page deciding anything.
 */

import React, { useCallback, useState } from 'react';
import { LuMap } from 'react-icons/lu';
import { Link, useParams } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { appendRoadmapEntries, listRoadmap } from '../../api/planning';
import { listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Badge, { type BadgeTone } from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { LINK_CLASS } from '../../components/ui/link';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import {
  CYCLE_STATUS_LABELS,
  MILESTONE_STATUS_LABELS,
  completionPercent,
  countsLabel,
  dateLabel,
} from '../../lib/planningDisplay';
import { projectsKey, roadmapKey } from '../../lib/queryKeys';
import type { RoadmapEntryRead, RoadmapKind } from '../../types/Api';

/** How often the first page re-reads. */
const POLL_MS = 60000;

/** How many entries a page holds. */
const PAGE_SIZE = 50;

/** How wide one day is on the timeline, in pixels. */
const PX_PER_DAY = 3.2;

/** The width of the name column, in pixels. */
const LABEL_WIDTH = 416;

/** Room after the last bar for its counts label. */
const LANE_TAIL = 260;

/** One day, in milliseconds. */
const DAY_MS = 86400000;

/** How each kind of entry reads in the interface. */
const KIND_LABELS: Record<RoadmapKind, string> = {
  cycle: 'Cycle',
  milestone: 'Milestone',
};

/** How each status reads, across both kinds. */
const STATUS_LABELS: Record<string, string> = {
  ...CYCLE_STATUS_LABELS,
  ...MILESTONE_STATUS_LABELS,
};

/** The badge tint each status takes, across both kinds. */
const STATUS_TONES: Record<string, BadgeTone> = {
  upcoming: 'neutral',
  planned: 'neutral',
  active: 'accent',
  in_progress: 'accent',
  completed: 'success',
  done: 'success',
  cancelled: 'danger',
};

/** Names an entry's kind, falling back for one added after this build. */
const kindLabel = (kind: RoadmapKind): string => KIND_LABELS[kind] ?? 'Entry';

/** Names an entry's status, falling back to the raw word. */
const statusLabel = (status: string): string => STATUS_LABELS[status] ?? status;

/** A calendar date as a UTC timestamp, or null when it is absent or malformed. */
const dayOf = (value: string | null): number | null => {
  if (value === null || value === '') return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) ? null : parsed;
};

/** The first day of the month a timestamp falls in. */
const monthStart = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** The first day of the month after the one a timestamp falls in. */
const nextMonth = (at: number): number => {
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
};

/** One month column on the timeline. */
interface MonthColumn {
  key: string;
  label: string;
  width: number;
}

/** The timeline's span and its month columns. */
interface Timeline {
  start: number;
  end: number;
  today: number;
  months: MonthColumn[];
  width: number;
}

/** Pixels from the timeline's start to a timestamp. */
const offsetOf = (timeline: Timeline, at: number): number =>
  ((at - timeline.start) / DAY_MS) * PX_PER_DAY;

/**
 * Lays out the months that cover every dated entry and today, or null when
 * nothing on the page has a date.
 */
const buildTimeline = (rows: RoadmapEntryRead[]): Timeline | null => {
  const today = monthStart(Date.now()) + DAY_MS * new Date().getUTCDate();
  const days = rows.flatMap((row) =>
    [dayOf(row.start_date), dayOf(row.target_date)].filter(
      (value): value is number => value !== null
    )
  );
  if (days.length === 0) return null;
  const start = monthStart(Math.min(...days, today));
  const end = nextMonth(Math.max(...days, today));
  const months: MonthColumn[] = [];
  for (let at = start; at < end; at = nextMonth(at)) {
    const date = new Date(at);
    months.push({
      key: String(at),
      label: date.toLocaleDateString(undefined, {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      width: ((nextMonth(at) - at) / DAY_MS) * PX_PER_DAY,
    });
  }
  return {
    start,
    end,
    today,
    months,
    width: ((end - start) / DAY_MS) * PX_PER_DAY,
  };
};

/** Where an entry's bar sits on the timeline, or null when it has no date. */
const barOf = (
  timeline: Timeline,
  entry: RoadmapEntryRead
): { left: number; width: number } | null => {
  const target = dayOf(entry.target_date);
  if (target === null) return null;
  const from = dayOf(entry.start_date) ?? timeline.start;
  const left = offsetOf(timeline, Math.min(from, target));
  const right = offsetOf(timeline, Math.max(from, target) + DAY_MS);
  return { left, width: Math.max(right - left, 8) };
};

/** The dated cycles and milestones of every project the caller can see. */
export const Roadmap: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<RoadmapKind | ''>('');

  const workspaceId = workspace?.id ?? '';
  const enabled = workspaceId !== '';
  const queryKey = roadmapKey(workspaceId, projectId, kind);

  const { data: projects } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled,
      queryKey: projectsKey(workspaceId),
      auth,
    }
  );

  const read = useCallback(
    (cursor: string | undefined, signal?: AbortSignal) =>
      listRoadmap(
        workspaceId,
        {
          ...(projectId === '' ? {} : { project_id: projectId }),
          ...(kind === '' ? {} : { kind }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: PAGE_SIZE,
        },
        signal
      ).then((page) => ({
        rows: page.entries,
        nextCursor: page.next_cursor,
      })),
    [workspaceId, projectId, kind]
  );

  const merge = useCallback(
    (held: RoadmapEntryRead[], incoming: RoadmapEntryRead[]) =>
      appendRoadmapEntries(held, incoming),
    []
  );

  const { rows, error, isLoading, isPaging, hasMore, loadMore } =
    useCursorPages(read, merge, { queryKey, enabled, intervalMs: POLL_MS });

  const byId = new Map((projects ?? []).map((item) => [item.id, item]));
  const timeline = buildTimeline(rows);
  const laneWidth = timeline === null ? 0 : timeline.width + LANE_TAIL;

  return (
    <WorkspaceShell
      title="Roadmap"
      toolbar={
        <>
          <SelectField
            id="roadmap-project"
            label="Project"
            hideLabel
            className="w-44"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            <option value="">Every project</option>
            {(projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            id="roadmap-kind"
            label="Kind"
            hideLabel
            className="w-44"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as RoadmapKind | '');
            }}
          >
            <option value="">Cycles and milestones</option>
            <option value="cycle">Cycles</option>
            <option value="milestone">Milestones</option>
          </SelectField>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the roadmap.')}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading roadmap" />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<LuMap />}
            message="Nothing is planned yet. Cycles and milestones appear here once a project has some."
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-line scrollbar-thin">
            <div style={{ minWidth: LABEL_WIDTH + laneWidth }}>
              <div className="flex h-8 border-b border-line">
                <div
                  className="sticky left-0 z-10 flex shrink-0 items-center border-r border-line bg-bg px-3 text-xs font-medium text-text-muted"
                  style={{ width: LABEL_WIDTH }}
                >
                  Name
                </div>
                {timeline !== null && (
                  <div className="relative flex" aria-hidden="true">
                    {timeline.months.map((month) => (
                      <div
                        key={month.key}
                        className="flex shrink-0 items-center border-r border-line px-2 text-xs whitespace-nowrap text-text-muted"
                        style={{ width: month.width }}
                      >
                        {month.label}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <ul>
                {rows.map((entry) => {
                  const project = byId.get(entry.project_id);
                  const bar = timeline === null ? null : barOf(timeline, entry);
                  const percent = completionPercent(entry.counts);
                  return (
                    <li
                      key={`${entry.kind}:${entry.id}`}
                      className="group flex h-row items-center border-b border-line last:border-b-0"
                    >
                      <div
                        className="sticky left-0 z-10 flex h-full shrink-0 items-center gap-2 border-r border-line bg-bg px-3 transition-colors duration-100 group-hover:bg-surface"
                        style={{ width: LABEL_WIDTH }}
                      >
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {entry.name}
                        </span>
                        <Badge tone={STATUS_TONES[entry.status] ?? 'neutral'}>
                          {statusLabel(entry.status)}
                        </Badge>
                        <span className="shrink-0 text-xs whitespace-nowrap text-text-muted tabular-nums">
                          {kindLabel(entry.kind)} ·{' '}
                          {dateLabel(entry.target_date, 'No date')}
                        </span>
                        {project !== undefined && (
                          <Link
                            to={`/w/${slug ?? ''}/p/${project.key_prefix}/${
                              entry.kind === 'cycle' ? 'cycles' : 'milestones'
                            }`}
                            className={`${LINK_CLASS} max-w-24 shrink-0 truncate text-xs`}
                          >
                            {project.name}
                          </Link>
                        )}
                      </div>
                      <div
                        className="relative h-full flex-1 transition-colors duration-100 group-hover:bg-surface"
                        style={{ minWidth: laneWidth }}
                      >
                        {timeline !== null && (
                          <span
                            aria-hidden="true"
                            className="absolute inset-y-0 w-px bg-line-strong"
                            style={{ left: offsetOf(timeline, timeline.today) }}
                          />
                        )}
                        {bar !== null && timeline !== null && (
                          <>
                            <div
                              aria-hidden="true"
                              className="absolute top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-accent-soft"
                              style={{ left: bar.left, width: bar.width }}
                            >
                              <div
                                className="h-full rounded-full bg-accent"
                                style={{ width: `${String(percent)}%` }}
                              />
                            </div>
                            <span
                              className="absolute top-1/2 -translate-y-1/2 text-xs whitespace-nowrap text-text-muted tabular-nums"
                              style={{ left: bar.left + bar.width + 8 }}
                            >
                              {countsLabel(entry.counts)}
                            </span>
                          </>
                        )}
                        {bar === null && (
                          <span className="absolute top-1/2 left-3 -translate-y-1/2 text-xs whitespace-nowrap text-text-muted tabular-nums">
                            {countsLabel(entry.counts)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}

        {hasMore && (
          <Button
            variant="secondary"
            size="sm"
            disabled={isPaging}
            onClick={loadMore}
          >
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Roadmap;
