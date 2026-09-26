/**
 * The workspace home: what the signed in person should look at first. It leads
 * with the open issues assigned to them, the way a tracker's own "my issues"
 * view does, then shows what moved recently, and beside both the cycles their
 * teams are running now and the projects in flight with their progress.
 *
 * Everything is read workspace wide in a handful of list calls. Issues are
 * workspace scoped and `assignee_id=me` resolves on the server, cycles come
 * from the roadmap, which already carries their rollups, and projects from the
 * shared project hook. Statuses, labels and people are read only for the teams
 * whose issues are on screen.
 */

import React, { useMemo } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery, type QueryKey } from '@webbpulse/api-client/react';
import {
  LuCalendarRange,
  LuChevronRight,
  LuCircleCheck,
  LuLayers,
  LuPlus,
  LuUsers,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { listIssues, ME } from '../../api/issues';
import { listRoadmap } from '../../api/planning';
import IssueRow from '../../components/issues/IssueRow';
import ProgressBar from '../../components/planning/ProgressBar';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import { Kbd } from '../../components/ui/badge';
import Button from '../../components/ui/button';
import EmptyState from '../../components/ui/empty-state';
import { Skeleton, SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useCreateIssue } from '../../hooks/useCreateIssue';
import { useCreateTeam } from '../../hooks/useCreateTeam';
import { useIssueContext } from '../../hooks/useIssueContext';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { errorMessage } from '../../lib/errors';
import {
  completionPercent,
  cycleDatesLabel,
  daysRemainingLabel,
  shortCountsLabel,
} from '../../lib/planningDisplay';
import {
  cyclePath,
  issuePath,
  myIssuesPath,
  projectPath,
  projectsPath,
  roadmapPath,
  teamCyclesPath,
} from '../../lib/paths';
import type {
  IssueRead,
  ProjectRead,
  RoadmapEntryRead,
  TeamRead,
} from '../../types/Api';

/** How often the home page re-reads its lists. */
const POLL_MS = 30000;

/** How many assigned issues the home page shows before "View all". */
const ASSIGNED_LIMIT = 10;

/** How many recently updated issues the home page shows. */
const RECENT_LIMIT = 6;

/** The project statuses that count as in flight. */
const ACTIVE_PROJECT_STATUSES = new Set(['in_progress', 'planned']);

/** How many projects the side column shows. */
const PROJECT_LIMIT = 5;

/** A section of the home page with its heading row. */
const Section: React.FC<{
  id: string;
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, title, count, action, children }) => (
  <section
    aria-labelledby={id}
    className="overflow-hidden rounded-md border border-line bg-bg"
  >
    <header className="flex h-10 items-center gap-2 border-b border-line bg-surface px-4">
      <h2 id={id} className="text-sm font-medium text-text">
        {title}
      </h2>
      {count !== undefined && (
        <span className="text-xs text-text-faint">{count}</span>
      )}
      <span className="flex-1" />
      {action}
    </header>
    {children}
  </section>
);

/** The small link a section heading carries to its full page. */
const SectionLink: React.FC<{ to: string; children: React.ReactNode }> = ({
  to,
  children,
}) => (
  <Link
    to={to}
    className="inline-flex items-center gap-0.5 rounded-xs text-xs text-text-muted transition-colors hover:text-text"
  >
    {children}
    <LuChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
  </Link>
);

/** A few placeholder lines for a side card while it loads. */
const SideSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div
    role="status"
    aria-busy="true"
    aria-label={label}
    className="space-y-4 p-4"
  >
    {[0, 1].map((index) => (
      <div key={index} className="space-y-2">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
    ))}
    <span className="sr-only">{label}</span>
  </div>
);

/** One active cycle, as the side column lists it. */
const CycleCard: React.FC<{
  entry: RoadmapEntryRead;
  team: TeamRead | undefined;
  slug: string;
}> = ({ entry, team, slug }) => {
  const percent = completionPercent(entry.counts);
  const body = (
    <>
      <div className="flex items-center gap-2 text-xs text-text-faint">
        <LuCalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
        <span className="truncate">{team?.name ?? 'Team'}</span>
        {entry.target_date !== null && (
          <span className="ml-auto shrink-0">
            {daysRemainingLabel(entry.target_date)}
          </span>
        )}
      </div>
      <p className="truncate text-sm font-medium text-text">{entry.name}</p>
      <div className="flex items-center gap-3">
        <ProgressBar percent={percent} className="flex-1" />
        <span className="shrink-0 text-xs text-text-muted tabular-nums">
          {String(percent)}%
        </span>
      </div>
      <p className="text-xs text-text-faint">
        {entry.start_date !== null && entry.target_date !== null
          ? `${cycleDatesLabel(entry.start_date, entry.target_date)} · `
          : ''}
        {shortCountsLabel(entry.counts)}
      </p>
    </>
  );
  const className =
    'block space-y-2 px-4 py-3 transition-colors duration-100 hover:bg-surface';
  return team === undefined ? (
    <div className={className}>{body}</div>
  ) : (
    <Link to={cyclePath(slug, team.key_prefix, entry.id)} className={className}>
      {body}
    </Link>
  );
};

/** One project in flight, as the side column lists it. */
const ProjectLine: React.FC<{ project: ProjectRead; slug: string }> = ({
  project,
  slug,
}) => {
  const percent = completionPercent(project.counts);
  return (
    <Link
      to={projectPath(slug, project.project_id)}
      className="block space-y-2 px-4 py-3 transition-colors duration-100 hover:bg-surface"
    >
      <div className="flex items-center gap-2">
        <ProjectStatusGlyph status={project.status} percent={percent} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
          {project.name}
        </span>
        <span className="shrink-0 text-xs text-text-muted tabular-nums">
          {String(percent)}%
        </span>
      </div>
      <ProgressBar percent={percent} />
      <p className="text-xs text-text-faint">
        {project.target_date === null
          ? 'No target date'
          : `Target ${project.target_date}`}
        {' · '}
        {shortCountsLabel(project.counts)}
      </p>
    </Link>
  );
};

/** The home page of one workspace. */
const WorkspaceHome: React.FC = () => {
  const { slug = '' } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const auth = useQueryAuth();
  const { user } = useAuth();
  const { workspace } = useWorkspace();
  const createTeam = useCreateTeam();
  const createIssue = useCreateIssue();
  const workspaceId = workspace?.id ?? '';

  const {
    data: teams,
    isLoading: teamsLoading,
    error: teamsError,
  } = useTeams();
  const hasTeams = teams !== null && teams.length > 0;
  const enabled = workspaceId !== '' && hasTeams;

  const assignedKey: QueryKey = ['issues', workspaceId, 'home', 'assigned'];
  const assigned = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        {
          assignee_id: ME,
          status_category_not: ['completed', 'cancelled'],
          sort: 'priority_desc',
          limit: ASSIGNED_LIMIT,
        },
        signal
      ),
    { intervalMs: POLL_MS, enabled, queryKey: assignedKey, auth }
  );

  const recentKey: QueryKey = ['issues', workspaceId, 'home', 'recent'];
  const recent = usePolledQuery(
    ({ signal }) =>
      listIssues(
        workspaceId,
        { sort: 'updated_desc', limit: RECENT_LIMIT + ASSIGNED_LIMIT },
        signal
      ),
    { intervalMs: POLL_MS, enabled, queryKey: recentKey, auth }
  );

  const cyclesKey: QueryKey = ['roadmap', workspaceId, '', 'cycle', 'home'];
  const cycles = usePolledQuery(
    ({ signal }) =>
      listRoadmap(workspaceId, { kind: 'cycle', limit: 100 }, signal),
    { intervalMs: POLL_MS, enabled, queryKey: cyclesKey, auth }
  );

  const { projects, isLoading: projectsLoading } = useWorkspaceProjects(
    workspaceId,
    '',
    enabled
  );

  const assignedIssues = useMemo(
    () => assigned.data?.issues ?? [],
    [assigned.data]
  );
  const recentIssues = useMemo(() => {
    const shown = new Set(assignedIssues.map((issue) => issue.id));
    return (recent.data?.issues ?? [])
      .filter((issue) => !shown.has(issue.id))
      .slice(0, RECENT_LIMIT);
  }, [recent.data, assignedIssues]);

  const teamIds = useMemo(
    () => [
      ...new Set(
        [...assignedIssues, ...recentIssues].map((issue) => issue.team_id)
      ),
    ],
    [assignedIssues, recentIssues]
  );
  const { context } = useIssueContext(workspaceId, teamIds, user?.id);

  const teamById = useMemo(
    () => new Map((teams ?? []).map((team) => [team.id, team])),
    [teams]
  );
  const myTeamIds = useMemo(() => {
    const mine = (teams ?? []).filter((team) => team.is_member === true);
    return new Set((mine.length > 0 ? mine : (teams ?? [])).map((t) => t.id));
  }, [teams]);

  const activeCycles = useMemo(
    () =>
      (cycles.data?.entries ?? []).filter(
        (entry) =>
          entry.kind === 'cycle' &&
          entry.status === 'active' &&
          myTeamIds.has(entry.team_id)
      ),
    [cycles.data, myTeamIds]
  );

  const activeProjects = useMemo(
    () =>
      projects
        .filter((project) => ACTIVE_PROJECT_STATUSES.has(project.status))
        .sort((a, b) =>
          a.status === b.status
            ? (a.target_date ?? '9999').localeCompare(b.target_date ?? '9999')
            : a.status === 'in_progress'
              ? -1
              : 1
        )
        .slice(0, PROJECT_LIMIT),
    [projects]
  );

  const rows: IssueRead[] = useMemo(
    () => [...assignedIssues, ...recentIssues],
    [assignedIssues, recentIssues]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: rows.length,
    resetKey: rows.map((issue) => issue.id).join(','),
    onActivate: (index) => {
      const issue = rows[index];
      if (issue !== undefined) void navigate(issuePath(slug, issue.key));
    },
  });

  const firstName = (user?.display_name ?? '').trim().split(/\s+/)[0] ?? '';

  const renderRow = (issue: IssueRead, index: number) => {
    const teamName = teamById.get(issue.team_id)?.name;
    return (
      <IssueRow
        key={issue.id}
        issue={issue}
        slug={slug}
        statuses={context.statuses}
        labels={context.labels}
        people={context.people}
        {...(teamName === undefined ? {} : { teamName })}
        isActive={activeIndex === index}
        rowRef={registerItem(index)}
        onPointerEnter={() => {
          setActiveIndex(index);
        }}
      />
    );
  };

  const createIssueAction = createIssue.canCreate ? (
    <Button
      variant="primary"
      size="sm"
      onClick={() => {
        createIssue.open();
      }}
    >
      <LuPlus className="h-3.5 w-3.5" aria-hidden="true" />
      New issue
    </Button>
  ) : undefined;

  if (teamsLoading || teams === null) {
    return (
      <WorkspaceShell title="Home">
        {teamsError !== null ? (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load your teams.')}
          />
        ) : (
          <SkeletonRows label="Loading your workspace" />
        )}
      </WorkspaceShell>
    );
  }

  if (!hasTeams) {
    return (
      <WorkspaceShell title="Home">
        <div className="mx-auto max-w-lg pt-10">
          <EmptyState
            icon={<LuUsers />}
            message={
              createTeam.canCreate
                ? 'Issues, cycles and projects all live in a team. Create your first team to start tracking work.'
                : 'You are not on a team in this workspace yet. Ask a workspace admin to add you to one.'
            }
            action={
              createTeam.canCreate ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    createTeam.open();
                  }}
                >
                  <LuPlus className="h-4 w-4" aria-hidden="true" />
                  Create a team
                </Button>
              ) : undefined
            }
          />
        </div>
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell title="Home" actions={createIssueAction}>
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <p className="text-xl font-semibold tracking-tight text-text">
            {firstName === '' ? 'Welcome back' : `Welcome back, ${firstName}`}
          </p>
          <p className="text-sm text-text-muted">
            Here is what is on your plate in{' '}
            {workspace?.name ?? 'this workspace'}.
          </p>
        </header>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0 space-y-6">
            <Section
              id="home-assigned"
              title="Assigned to you"
              {...(assigned.data === null
                ? {}
                : { count: assignedIssues.length })}
              action={
                <SectionLink to={myIssuesPath(slug)}>View all</SectionLink>
              }
            >
              {assigned.error !== null ? (
                <div className="p-4">
                  <ErrorAlert
                    message={errorMessage(
                      assigned.error,
                      'Could not load your issues.'
                    )}
                  />
                </div>
              ) : assigned.data === null ? (
                <SkeletonRows count={4} label="Loading your issues" />
              ) : assignedIssues.length === 0 ? (
                <EmptyState
                  className="py-10"
                  icon={<LuCircleCheck />}
                  message="Nothing open is assigned to you. Pick something up, or file a new issue."
                  action={
                    createIssue.canCreate ? (
                      <span className="flex items-center gap-2 text-xs text-text-faint">
                        Press <Kbd>C</Kbd> to create an issue
                      </span>
                    ) : undefined
                  }
                />
              ) : (
                <ul aria-label="Issues assigned to you" className="-mb-px">
                  {assignedIssues.map((issue, index) =>
                    renderRow(issue, index)
                  )}
                </ul>
              )}
            </Section>

            <Section id="home-recent" title="Recently updated">
              {recent.error !== null ? (
                <div className="p-4">
                  <ErrorAlert
                    message={errorMessage(
                      recent.error,
                      'Could not load recent issues.'
                    )}
                  />
                </div>
              ) : recent.data === null ? (
                <SkeletonRows count={3} label="Loading recent issues" />
              ) : recentIssues.length === 0 ? (
                <EmptyState
                  className="py-10"
                  message="Issues your teams change will show up here."
                />
              ) : (
                <ul aria-label="Recently updated issues" className="-mb-px">
                  {recentIssues.map((issue, index) =>
                    renderRow(issue, assignedIssues.length + index)
                  )}
                </ul>
              )}
            </Section>
          </div>

          <aside className="min-w-0 space-y-6" aria-label="Planning">
            <Section
              id="home-cycles"
              title="Active cycles"
              action={<SectionLink to={roadmapPath(slug)}>Roadmap</SectionLink>}
            >
              {cycles.data === null && cycles.error === null ? (
                <SideSkeleton label="Loading cycles" />
              ) : activeCycles.length === 0 ? (
                <div className="space-y-2 px-4 py-6 text-center">
                  <p className="text-sm text-text-muted">
                    None of your teams has a cycle running.
                  </p>
                  {teams[0] !== undefined && (
                    <Link
                      to={teamCyclesPath(slug, teams[0].key_prefix)}
                      className="text-xs text-accent hover:underline"
                    >
                      Plan a cycle
                    </Link>
                  )}
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {activeCycles.map((entry) => (
                    <li key={entry.id}>
                      <CycleCard
                        entry={entry}
                        team={teamById.get(entry.team_id)}
                        slug={slug}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section
              id="home-projects"
              title="Active projects"
              action={
                <SectionLink to={projectsPath(slug)}>All projects</SectionLink>
              }
            >
              {projectsLoading && projects.length === 0 ? (
                <SideSkeleton label="Loading projects" />
              ) : activeProjects.length === 0 ? (
                <div className="space-y-2 px-4 py-6 text-center">
                  <LuLayers
                    className="mx-auto h-5 w-5 text-text-faint"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-text-muted">
                    No projects are planned or in progress.
                  </p>
                  <Link
                    to={projectsPath(slug)}
                    className="text-xs text-accent hover:underline"
                  >
                    Start a project
                  </Link>
                </div>
              ) : (
                <ul className="divide-y divide-line">
                  {activeProjects.map((project) => (
                    <li key={project.project_id}>
                      <ProjectLine project={project} slug={slug} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </aside>
        </div>
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceHome;
