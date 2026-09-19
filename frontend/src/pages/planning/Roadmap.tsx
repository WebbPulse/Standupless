/**
 * The workspace roadmap: every cycle and milestone the caller can see, by date
 * ascending with the undated entries last. There is no project list control
 * that widens the read, only one that narrows it: the server fans out over
 * exactly the projects the caller's own context allows, so a guest sees their
 * projects and nothing else without this page deciding anything.
 */

import React, { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { appendRoadmapEntries, listRoadmap } from '../../api/planning';
import { listProjects } from '../../api/projects';
import { ErrorAlert } from '../../components/ui/alert';
import Button from '../../components/ui/button';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCursorPages } from '../../hooks/useCursorPages';
import { useWorkspace } from '../../hooks/useWorkspace';
import { errorMessage } from '../../lib/errors';
import {
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

/** How each kind of entry reads in the interface. */
const KIND_LABELS: Record<RoadmapKind, string> = {
  cycle: 'Cycle',
  milestone: 'Milestone',
};

/** Names an entry's kind, falling back for one added after this build. */
const kindLabel = (kind: RoadmapKind): string => KIND_LABELS[kind] ?? 'Entry';

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

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-xl font-semibold text-white">Roadmap</h2>
          <div className="flex flex-wrap items-end gap-3">
            <SelectField
              id="roadmap-project"
              label="Project"
              className="w-48"
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
              className="w-40"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as RoadmapKind | '');
              }}
            >
              <option value="">Cycles and milestones</option>
              <option value="cycle">Cycles</option>
              <option value="milestone">Milestones</option>
            </SelectField>
          </div>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the roadmap.')}
          />
        )}

        {isLoading ? (
          <Spinner label="Loading roadmap" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">
            Nothing is planned yet. Cycles and milestones appear here once a
            project has some.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((entry) => {
              const project = byId.get(entry.project_id);
              return (
                <li
                  key={`${entry.kind}:${entry.id}`}
                  className="space-y-1 rounded-md border border-slate-700 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-white">{entry.name}</span>
                    <span className="text-xs text-slate-500">
                      {kindLabel(entry.kind)} ·{' '}
                      {dateLabel(entry.target_date, 'No date')}
                    </span>
                    {project !== undefined && (
                      <Link
                        to={`/w/${slug ?? ''}/p/${project.key_prefix}/${
                          entry.kind === 'cycle' ? 'cycles' : 'milestones'
                        }`}
                        className="ml-auto text-xs text-sky-400 hover:text-sky-300"
                      >
                        {project.name}
                      </Link>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">
                    {countsLabel(entry.counts)} ·{' '}
                    {String(completionPercent(entry.counts))}% complete
                  </p>
                </li>
              );
            })}
          </ul>
        )}

        {hasMore && (
          <Button variant="secondary" disabled={isPaging} onClick={loadMore}>
            {isPaging ? 'Loading' : 'Load more'}
          </Button>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default Roadmap;
