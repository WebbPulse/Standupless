/**
 * One project. The overview puts the name, the summary, the progress and the
 * milestones in the main column with a properties rail beside it, and the
 * issues tab is the project's issues as a list or board that groups and
 * filters by milestone too. Every property edits in place and shows at once,
 * and a failed write is undone with a notice.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuCalendar,
  LuCalendarCheck,
  LuChevronRight,
  LuEllipsis,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { deleteProject, getProject, updateProject } from '../../api/planning';
import { DatePicker } from '../../components/issues/PropertyPickers';
import EditableText from '../../components/planning/EditableText';
import MilestonesSection from '../../components/planning/MilestonesSection';
import ProgressRing from '../../components/planning/ProgressRing';
import ProjectIssuesView from '../../components/planning/ProjectIssuesView';
import {
  LeadPicker,
  ProjectStatusPicker,
  TeamsPicker,
} from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { StatusGlyph } from '../../components/ui/glyphs';
import Menu, { MenuItem } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useCreatePlannedIssue } from '../../hooks/useCreatePlannedIssue';
import { usePlanningIssues } from '../../hooks/usePlanningIssues';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useProjectMilestones } from '../../hooks/useProjectMilestones';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectsPath } from '../../lib/paths';
import { completionPercent } from '../../lib/planningDisplay';
import {
  ISSUE_GROUP_LABELS,
  ISSUE_GROUP_ORDER,
  canEditProject,
  categoryCounts,
} from '../../lib/planningModel';
import { projectsKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type {
  MilestoneRead,
  ProjectRead,
  ProjectUpdate,
  StatusCategory,
} from '../../types/Api';

/** How often the project re-reads. */
const POLL_MS = 30000;

/** The two tabs a project page has. */
type ProjectTab = 'overview' | 'issues';

/** The key one project's read runs under. */
const projectKey = (workspaceId: string, projectId: string) =>
  ['project', workspaceId, projectId] as const;

/** Props for TabBar: the chosen tab and how to change it. */
interface TabBarProps {
  tab: ProjectTab;
  issueCount: number;
  onChange: (tab: ProjectTab) => void;
}

/** The Overview and Issues tabs under the page title. */
const TabBar: React.FC<TabBarProps> = ({ tab, issueCount, onChange }) => (
  <div role="tablist" aria-label="Project" className="flex items-center gap-1">
    {(['overview', 'issues'] as const).map((value) => (
      <button
        key={value}
        type="button"
        role="tab"
        aria-selected={tab === value}
        onClick={() => {
          onChange(value);
        }}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors duration-100',
          tab === value
            ? 'bg-raised text-text'
            : 'text-text-muted hover:bg-surface hover:text-text'
        )}
      >
        {value === 'overview' ? 'Overview' : 'Issues'}
        {value === 'issues' && (
          <span className="text-text-faint tabular-nums">
            {String(issueCount)}
          </span>
        )}
      </button>
    ))}
  </div>
);

/** Props for RailRow: a property's name and its control. */
interface RailRowProps {
  label: string;
  children: React.ReactNode;
}

/** One row of the properties rail. */
const RailRow: React.FC<RailRowProps> = ({ label, children }) => (
  <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-2">
    <span className="text-xs text-text-muted">{label}</span>
    <div className="min-w-0">{children}</div>
  </div>
);

/** Props for ProgressSection: the project and the issues read so far. */
interface ProgressSectionProps {
  project: ProjectRead;
  byCategory: Record<StatusCategory, number> | null;
}

/**
 * How far along the project is: scope, started and completed as the server
 * rolls them up, then a bar per workflow stage from the issues themselves.
 */
const ProgressSection: React.FC<ProgressSectionProps> = ({
  project,
  byCategory,
}) => {
  const { counts } = project;
  const scope = counts.total - counts.cancelled;
  const started = counts.in_progress + counts.done;
  const percent = completionPercent(counts);
  const share = (value: number): string =>
    scope <= 0 ? '0%' : `${String(Math.round((value / scope) * 100))}%`;
  const stats = [
    { label: 'Scope', value: scope, detail: `${String(scope)} issues` },
    { label: 'Started', value: started, detail: share(started) },
    { label: 'Completed', value: counts.done, detail: share(counts.done) },
  ];
  const breakdown =
    byCategory ??
    ({
      backlog: 0,
      unstarted: counts.todo,
      started: counts.in_progress,
      completed: counts.done,
      cancelled: counts.cancelled,
    } satisfies Record<StatusCategory, number>);
  const most = Math.max(1, ...Object.values(breakdown));
  return (
    <section aria-labelledby="project-progress" className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 id="project-progress" className="text-sm font-medium text-text">
          Progress
        </h2>
        <ProgressRing percent={percent} />
        <span className="text-xs text-text-muted tabular-nums">
          {`${String(percent)}%`}
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-md border border-line bg-surface px-3 py-2"
          >
            <dt className="text-xs text-text-muted">{stat.label}</dt>
            <dd className="mt-0.5 flex items-baseline gap-1.5">
              <span className="text-lg font-semibold text-text tabular-nums">
                {String(stat.value)}
              </span>
              <span className="text-xs text-text-faint tabular-nums">
                {stat.detail}
              </span>
            </dd>
          </div>
        ))}
      </dl>
      <ul aria-label="Issues by status" className="space-y-1.5">
        {ISSUE_GROUP_ORDER.map((category) => {
          const count = breakdown[category];
          return (
            <li
              key={category}
              className="grid grid-cols-[7rem_minmax(0,1fr)_2rem] items-center gap-3 text-xs"
            >
              <span className="flex items-center gap-2 text-text-muted">
                <StatusGlyph category={category} />
                {ISSUE_GROUP_LABELS[category]}
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-raised">
                <span
                  className={cn(
                    'block h-full rounded-full',
                    category === 'completed'
                      ? 'bg-accent'
                      : category === 'started'
                        ? 'bg-warning'
                        : 'bg-line-strong'
                  )}
                  style={{ width: `${String((count / most) * 100)}%` }}
                />
              </span>
              <span className="text-right text-text-muted tabular-nums">
                {String(count)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** One project's overview and its issues. */
export const ProjectDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const {
    teams,
    workspaceId,
    isLoading: isResolving,
    error: teamsError,
  } = useTeam(undefined);
  const projectId = id ?? '';
  const tab: ProjectTab =
    params.get('tab') === 'issues' ? 'issues' : 'overview';
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [deletingMilestone, setDeletingMilestone] =
    useState<MilestoneRead | null>(null);

  const detailKey = projectKey(workspaceId, projectId);
  const listKey = projectsKey(workspaceId, '', '');

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getProject(workspaceId, projectId, undefined, signal),
    [workspaceId, projectId]
  );
  const {
    data: server,
    error,
    isLoading,
  } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: workspaceId !== '' && projectId !== '',
    queryKey: detailKey,
    auth,
  });

  const { value: project, update } = useOptimisticRecord<
    ProjectRead,
    ProjectUpdate
  >(server ?? null, {
    write: (patch) => updateProject(workspaceId, projectId, patch),
    isSame: (left, right) => left.project_id === right.project_id,
    invalidate: [detailKey, listKey],
    failureMessage: (failure) =>
      errorMessage(
        failure,
        'Could not update the project. It has been undone.'
      ),
  });

  const serverTeamIds = project?.team_ids;
  const teamIds = useMemo(() => serverTeamIds ?? [], [serverTeamIds]);
  const { statuses, people } = usePlanningTeamLists(workspaceId, teamIds);
  const issuesKey = ['projectIssues', workspaceId, projectId] as const;
  const issues = usePlanningIssues(
    workspaceId,
    { project_id: projectId },
    issuesKey,
    project !== null
  );

  const milestones = useProjectMilestones(
    workspaceId,
    projectId,
    project !== null
  );

  const projectTeams = useMemo(
    () => teams.filter((team) => teamIds.includes(team.id)),
    [teams, teamIds]
  );
  const createTeam = projectTeams.find((team) =>
    canWriteIssues(workspace?.role, team.role)
  );
  const { open: openCreate, canCreate } = useCreatePlannedIssue(
    workspaceId,
    issuesKey
  );
  const createIssue = useCallback((): void => {
    if (createTeam === undefined) return;
    openCreate({ teamId: createTeam.id, projectId });
  }, [openCreate, createTeam, projectId]);

  const mayCreate = canCreate && createTeam !== undefined;
  useShortcut({
    keys: 'c',
    label: 'New issue in this project',
    group: 'Project',
    enabled: mayCreate,
    handler: (event) => {
      event?.preventDefault();
      createIssue();
    },
  });

  const setTab = (next: ProjectTab): void => {
    const held = new URLSearchParams(params);
    if (next === 'overview') held.delete('tab');
    else held.set('tab', next);
    setParams(held, { replace: true });
  };

  const openMilestoneIssues = (milestoneId: string): void => {
    const held = new URLSearchParams(params);
    held.set('tab', 'issues');
    held.delete('f');
    held.append('f', `milestone.is:${milestoneId}`);
    setParams(held);
  };

  const byCategory = useMemo(
    () =>
      issues.isLoading || issues.hasMore || statuses.length === 0
        ? null
        : categoryCounts(issues.rows, statuses),
    [issues.isLoading, issues.hasMore, issues.rows, statuses]
  );

  const crumbs = (
    <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={projectsPath(slug)}
        className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Projects
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 text-text-faint"
        aria-hidden="true"
      />
    </span>
  );

  if (isResolving || (isLoading && project === null)) {
    return (
      <WorkspaceShell title="Project" leading={crumbs}>
        {teamsError !== null && (
          <ErrorAlert
            message={errorMessage(teamsError, 'Could not load the teams.')}
          />
        )}
        <SkeletonRows label="Loading project" />
      </WorkspaceShell>
    );
  }

  if (project === null) {
    return (
      <WorkspaceShell title="Project not found" leading={crumbs}>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this project.')}
          />
        )}
        <EmptyState message="That project does not exist, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const canEdit = canEditProject(workspace?.role, project, teams);
  const canDelete =
    isTeamAdmin(workspace?.role, undefined) ||
    projectTeams.some((team) => isTeamAdmin(workspace?.role, team.role));
  const percent = completionPercent(project.counts);

  const remove = (): void => {
    setDeleteError(null);
    deleteProject(workspaceId, projectId).then(
      () => {
        setIsConfirmingDelete(false);
        showToast(`Deleted ${project.name}`);
        void navigate(projectsPath(slug));
      },
      (failure: unknown) => {
        setDeleteError(failure);
      }
    );
  };

  const rail = (
    <aside
      aria-label="Properties"
      className="space-y-1.5 border-line lg:w-72 lg:shrink-0 lg:border-l lg:pl-6"
    >
      <h2 className="pb-1 text-xs font-medium text-text-muted">Properties</h2>
      <RailRow label="Status">
        <ProjectStatusPicker
          value={project.status}
          percent={percent}
          disabled={!canEdit}
          onChange={(status) => {
            void update({ status });
          }}
        />
      </RailRow>
      <RailRow label="Lead">
        <LeadPicker
          value={project.lead_id}
          people={people}
          disabled={!canEdit}
          onChange={(leadId) => {
            void update({ lead_id: leadId });
          }}
        />
      </RailRow>
      <RailRow label="Teams">
        <TeamsPicker
          value={project.team_ids}
          teams={teams}
          disabled={!canEdit}
          onChange={(next) => {
            if (next.length > 0) void update({ team_ids: next });
          }}
        />
      </RailRow>
      <RailRow label="Start date">
        <DatePicker
          field="Start date"
          value={project.start_date}
          disabled={!canEdit}
          icon={<LuCalendar className="h-3.5 w-3.5" />}
          {...(project.target_date === null
            ? {}
            : { max: project.target_date })}
          onChange={(value) => {
            void update({ start_date: value });
          }}
        />
      </RailRow>
      <RailRow label="Target date">
        <DatePicker
          field="Target date"
          value={project.target_date}
          disabled={!canEdit}
          icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
          {...(project.start_date === null ? {} : { min: project.start_date })}
          onChange={(value) => {
            void update({ target_date: value });
          }}
        />
      </RailRow>
    </aside>
  );

  return (
    <WorkspaceShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProjectStatusGlyph status={project.status} percent={percent} />
          <span className="truncate">{project.name}</span>
        </span>
      }
      leading={crumbs}
      flush
      toolbar={
        <TabBar tab={tab} issueCount={project.counts.total} onChange={setTab} />
      }
      actions={
        <div className="flex items-center gap-1">
          {mayCreate && (
            <Button variant="secondary" size="sm" onClick={createIssue}>
              <LuPlus aria-hidden="true" />
              New issue
            </Button>
          )}
          {canDelete && (
            <Menu
              label="Project actions"
              align="end"
              trigger={(trigger) => (
                <IconButton label="Project actions" size="sm" {...trigger}>
                  <LuEllipsis className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              <MenuItem
                danger
                onSelect={() => {
                  setIsConfirmingDelete(true);
                }}
              >
                <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Delete project
              </MenuItem>
            </Menu>
          )}
        </div>
      }
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not refresh this project.')}
          />
        </div>
      )}
      {tab === 'issues' ? (
        <ProjectIssuesView
          workspaceId={workspaceId}
          slug={slug}
          projectId={projectId}
          teams={projectTeams}
          milestones={milestones.milestones}
          canEdit={createTeam !== undefined}
          createTeamId={createTeam?.id}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 lg:flex-row lg:px-8">
            <div className="min-w-0 flex-1 space-y-8">
              <div className="space-y-2">
                <EditableText
                  label="Project name"
                  placeholder="Project name"
                  value={project.name}
                  disabled={!canEdit}
                  className="text-2xl font-semibold"
                  onSave={(name) => {
                    if (name !== '') void update({ name });
                  }}
                />
                <EditableText
                  multiline
                  label="Description"
                  placeholder={
                    canEdit
                      ? 'Add a description, the goal and what done looks like...'
                      : 'No description.'
                  }
                  value={project.description ?? ''}
                  disabled={!canEdit}
                  className="text-sm leading-relaxed text-text-muted"
                  onSave={(description) => {
                    void update({
                      description: description === '' ? null : description,
                    });
                  }}
                />
              </div>
              <div className="lg:hidden">{rail}</div>
              <ProgressSection project={project} byCategory={byCategory} />
              <MilestonesSection
                milestones={milestones.milestones}
                isLoading={milestones.isLoading}
                canEdit={canEdit}
                onCreate={(name) => milestones.create({ name })}
                onUpdate={(milestoneId, patch) => {
                  void milestones.update(milestoneId, patch);
                }}
                onDelete={setDeletingMilestone}
                onOpenIssues={openMilestoneIssues}
              />
              <section aria-labelledby="project-issues-preview">
                <div className="mb-2 flex items-center justify-between">
                  <h2
                    id="project-issues-preview"
                    className="text-sm font-medium text-text"
                  >
                    Issues
                  </h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setTab('issues');
                    }}
                  >
                    View all
                  </Button>
                </div>
                <p className="text-xs text-text-muted">
                  {project.counts.total === 0
                    ? 'No issues are in this project yet.'
                    : `${String(project.counts.total)} issues across ${String(projectTeams.length)} ${projectTeams.length === 1 ? 'team' : 'teams'}.`}
                </p>
              </section>
            </div>
            <div className="hidden lg:block">{rail}</div>
          </div>
        </div>
      )}

      {deletingMilestone !== null && (
        <Dialog
          open
          size="sm"
          title={`Delete ${deletingMilestone.name}`}
          description="Its issues stay in the project with no milestone."
          onClose={() => {
            setDeletingMilestone(null);
          }}
        >
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setDeletingMilestone(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const target = deletingMilestone;
                setDeletingMilestone(null);
                void milestones.remove(target.milestone_id).then((done) => {
                  if (done) showToast(`Deleted ${target.name}`);
                });
              }}
            >
              Delete milestone
            </Button>
          </div>
        </Dialog>
      )}

      {isConfirmingDelete && canDelete && (
        <Dialog
          open
          size="sm"
          title={`Delete ${project.name}`}
          description="Its issues stay where they are and stop being attached to a project."
          onClose={() => {
            setIsConfirmingDelete(false);
          }}
        >
          <div className="space-y-3">
            {deleteError !== null && (
              <ErrorAlert
                message={errorMessage(
                  deleteError,
                  'Could not delete this project.'
                )}
              />
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setIsConfirmingDelete(false);
                }}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={remove}>
                Delete project
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default ProjectDetail;
