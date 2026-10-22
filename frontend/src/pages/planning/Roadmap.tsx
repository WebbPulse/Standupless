/**
 * The workspace roadmap: every project as a bar from its start to its target
 * date on a scrolling timeline, drawn by the shared project timeline. The
 * team filter, grouping and zoom live in the URL so an arranged roadmap can
 * be shared, and lanes can be grouped under pinned group headers.
 */

import React, { useMemo, useRef, useState } from 'react';
import { LuCalendarRange } from 'react-icons/lu';
import { useSearchParams } from 'react-router-dom';
import { TeamKey } from '../../components/planning/ProjectPickers';
import ProjectTimeline, {
  TimelineControls,
  type ProjectTimelineHandle,
} from '../../components/planning/ProjectTimeline';
import ProjectsDisplayMenu from '../../components/planning/ProjectsDisplayMenu';
import { ErrorAlert } from '../../components/ui/alert';
import { Combobox } from '../../components/ui/combobox';
import EmptyState from '../../components/ui/empty-state';
import { Popover } from '../../components/ui/popover';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useInitiatives } from '../../hooks/useInitiatives';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useTeam } from '../../hooks/useTeam';
import { useTimelineShortcuts } from '../../hooks/useTimelineShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { errorMessage } from '../../lib/errors';
import { groupProjects, parseGrouping } from '../../lib/projectList';
import { TIMELINE_ZOOMS, type TimelineZoom } from '../../lib/timeline';
import type { ProjectRead } from '../../types/Api';
import { teamTree } from '../../lib/teamOrder';

/** Orders projects by start, then target, undated last, then by name. */
const byStart = (left: ProjectRead, right: ProjectRead): number => {
  const a = left.start_date ?? left.target_date;
  const b = right.start_date ?? right.target_date;
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  }
  return left.name.localeCompare(right.name);
};

/** The workspace roadmap of projects on a timeline. */
export const Roadmap: React.FC = () => {
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const [params, setParams] = useSearchParams();
  const {
    teams,
    workspaceId,
    isLoading: isResolvingTeams,
    error: teamsError,
  } = useTeam(undefined);
  const teamFilter = params.get('team') ?? '';
  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);
  const zoomParam = params.get('zoom');
  const zoom: TimelineZoom = TIMELINE_ZOOMS.includes(zoomParam as TimelineZoom)
    ? (zoomParam as TimelineZoom)
    : 'month';
  const grouping = parseGrouping(params.get('group'), 'none');
  const [folded, setFolded] = useState<string[]>([]);
  const timeline = useRef<ProjectTimelineHandle | null>(null);

  const { projects, error, isLoading, queryKey } = useWorkspaceProjects(
    workspaceId,
    filteredTeam?.id ?? '',
    !isResolvingTeams && (teamFilter === '' || filteredTeam !== undefined)
  );
  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const { people } = usePlanningTeamLists(workspaceId, teamIds, {
    statuses: false,
    labels: false,
  });
  const { initiatives } = useInitiatives(
    workspaceId,
    grouping === 'initiative'
  );

  const rows = useMemo(() => [...projects].sort(byStart), [projects]);
  const groups = useMemo(
    () => groupProjects(rows, grouping, people, teams, { initiatives }),
    [rows, grouping, people, teams, initiatives]
  );

  const setParam = (field: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(field);
    else next.set(field, value);
    setParams(next, { replace: true });
  };

  const controls = {
    zoom,
    onZoomChange: (value: TimelineZoom) => {
      setParam('zoom', value === 'month' ? '' : value);
    },
    onToday: () => {
      timeline.current?.scrollToToday();
    },
  };
  useTimelineShortcuts({ ...controls, group: 'Roadmap' });

  const showSkeleton =
    teamsError === null && (isResolvingTeams || isLoading) && rows.length === 0;

  return (
    <WorkspaceShell
      title="Roadmap"
      flush
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <Popover
            label="Team"
            contentClassName="w-60"
            trigger={(trigger) => (
              <button
                type="button"
                {...trigger}
                aria-label={`Team filter: ${filteredTeam?.name ?? 'All teams'}`}
                className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line px-2 text-xs text-text hover:border-line-strong hover:bg-raised"
              >
                {filteredTeam === undefined ? (
                  'All teams'
                ) : (
                  <>
                    <TeamKey keyPrefix={filteredTeam.key_prefix} />
                    {filteredTeam.name}
                  </>
                )}
              </button>
            )}
          >
            {(close) => (
              <Combobox
                label="Team"
                placeholder="Filter by team"
                options={[
                  { value: '', label: 'All teams' },
                  ...teamTree(teams).map(({ team, nested }) => ({
                    value: team.key_prefix,
                    label: team.name,
                    icon: <TeamKey keyPrefix={team.key_prefix} />,
                    indent: nested,
                  })),
                ]}
                selected={[teamFilter]}
                onSelect={(value) => {
                  close();
                  setParam('team', value);
                }}
              />
            )}
          </Popover>
          <div className="ml-auto flex items-center gap-1">
            <ProjectsDisplayMenu
              grouping={grouping}
              onGroupingChange={(value) => {
                setParam('group', value === 'none' ? '' : value);
              }}
            />
            <TimelineControls {...controls} />
          </div>
        </div>
      }
    >
      {(teamsError !== null || (error !== null && error !== undefined)) && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(
              teamsError ?? error,
              'Could not load the roadmap. Try again shortly.'
            )}
          />
        </div>
      )}
      {showSkeleton ? (
        <SkeletonRows label="Loading roadmap" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<LuCalendarRange />}
          message="No projects to plan yet. Projects show here as bars from their start to their target date."
        />
      ) : (
        <ProjectTimeline
          ref={timeline}
          groups={groups}
          projects={rows}
          slug={slug}
          workspaceId={workspaceId}
          teams={teams}
          people={people}
          workspaceRole={workspace?.role}
          zoom={zoom}
          folded={folded}
          onToggleGroup={(key) => {
            setFolded((held) =>
              held.includes(key)
                ? held.filter((value) => value !== key)
                : [...held, key]
            );
          }}
          refreshKey={queryKey}
          listLabel="Projects on the roadmap"
          testId="roadmap-scroller"
        />
      )}
    </WorkspaceShell>
  );
};

export default Roadmap;
