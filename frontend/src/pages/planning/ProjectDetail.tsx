/**
 * One project. The overview leads with the name and a row of property chips
 * under it, then the description, the milestones, the Resources links and
 * the issues, with a side panel of progress: the numbers, a graph over the
 * project's days, a breakdown by assignee, label and priority whose rows
 * filter the issues tab, and each milestone's share done, which scopes the
 * panel to that milestone. The issues tab is the project's issues as a
 * list or board that groups and filters by milestone too. Every property
 * edits in place and shows at once, and a failed write is undone with a
 * notice. The chip row also names the projects this one is blocked by and
 * the ones it blocks, and links or unlinks them in place. The chips answer
 * the keyboard too: S status, P priority, A lead, M members, H health,
 * Shift+S start date and Shift+D target date open the same pickers.
 *
 * The updates tab is the project's running account of itself: each update is
 * a short write up and a health call, newest first. `?tab=updates` opens it,
 * which is where email, webhook and inbox links land. Each project has an
 * update cadence, its own or the workspace default; once an update is due the
 * header, the overview and the updates tab say so, with a way straight to the
 * composer, and the command palette offers the same.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuArchive,
  LuArchiveRestore,
  LuArrowRight,
  LuCalendar,
  LuCalendarCheck,
  LuChevronRight,
  LuEllipsis,
  LuPencilLine,
  LuPlus,
  LuTrash2,
} from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  archiveProject,
  createProjectLink,
  deleteProject,
  deleteProjectLink,
  getProject,
  unarchiveProject,
  updateProject,
  updateProjectLink,
} from '../../api/planning';
import { PriorityPicker } from '../../components/issues/PropertyPickers';
import PlanningDatePicker from '../../components/planning/PlanningDatePicker';
import { isCoarse } from '../../lib/dateResolution';
import EditableText from '../../components/planning/EditableText';
import CustomerRequestsSection from '../../components/customers/CustomerRequestsSection';
import DocumentsSection from '../../components/planning/DocumentsSection';
import MilestonesSection from '../../components/planning/MilestonesSection';
import ProjectIcon from '../../components/planning/ProjectIcon';
import ProjectIssuesView, {
  PROJECT_VIEW_BASE,
} from '../../components/planning/ProjectIssuesView';
import {
  CadencePicker,
  DependencyPicker,
  HealthPicker,
  InitiativePicker,
  LeadPicker,
  MembersPicker,
  ProjectLabelsPicker,
  ProjectLookPicker,
  ProjectStatusPicker,
  TeamsPicker,
} from '../../components/planning/ProjectPickers';
import ProjectPropertyKeys from '../../components/planning/ProjectPropertyKeys';
import ProjectActivityFeed from '../../components/planning/ProjectActivityFeed';
import ProjectProgressPanel from '../../components/planning/ProjectProgressPanel';
import ProjectResources from '../../components/planning/ProjectResources';
import ProjectUpdatesFeed from '../../components/planning/ProjectUpdatesFeed';
import { DocumentLinkContext } from '../../contexts/DocumentLinkContext';
import UpdateDueBadge from '../../components/planning/UpdateDueBadge';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import LoadError from '../../components/ui/load-error';
import Menu, { MenuItem } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import useCloseProjectPrompt from '../../hooks/useCloseProjectPrompt';
import { useProjectLabels } from '../../hooks/useProjectLabels';
import useCreateDocumentCommand from '../../hooks/useCreateDocumentCommand';
import { useCreatePlannedIssue } from '../../hooks/useCreatePlannedIssue';
import useDocumentTemplates from '../../hooks/useDocumentTemplates';
import { useInitiatives } from '../../hooks/useInitiatives';
import { usePlanningIssues } from '../../hooks/usePlanningIssues';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useProjectDependencies } from '../../hooks/useProjectDependencies';
import { useProjectHistory } from '../../hooks/useProjectHistory';
import { useProjectMilestones } from '../../hooks/useProjectMilestones';
import { useProjectUpdates } from '../../hooks/useProjectUpdates';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { canWriteIssues, isTeamAdmin } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage, hasStatus, NOT_FOUND } from '../../lib/errors';
import type { BreakdownField } from '../../lib/cycleBreakdown';
import { personLabel } from '../../lib/issuePeople';
import {
  filterValuesFor,
  narrowFilters,
  parseViewState,
  writeViewState,
} from '../../lib/issueView';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectsPath } from '../../lib/paths';
import { progressPercent, updateNudge } from '../../lib/planningDisplay';
import { canEditProject } from '../../lib/planningModel';
import {
  initiativesKey,
  projectDetailKey,
  projectsKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import FavoriteButton from '../../components/ui/FavoriteButton';
import FollowButton from '../../components/planning/FollowButton';
import type {
  MilestoneRead,
  ProjectRead,
  ProjectUpdate,
} from '../../types/Api';

/** How often the project re-reads. */
const POLL_MS = 30000;

/** The tabs a project page has. */
type ProjectTab = 'overview' | 'updates' | 'issues';

/** The tabs in the order the bar shows them. */
const TABS: ProjectTab[] = ['overview', 'updates', 'issues'];

/** How each tab reads. */
const TAB_LABELS: Record<ProjectTab, string> = {
  overview: 'Overview',
  updates: 'Updates',
  issues: 'Issues',
};

/** The tab a `?tab=` value names, the overview for anything else. */
const tabFrom = (value: string | null): ProjectTab =>
  value === 'issues' || value === 'updates' ? value : 'overview';

/** Props for TabBar: the chosen tab and how to change it. */
interface TabBarProps {
  tab: ProjectTab;
  issueCount: number;
  onChange: (tab: ProjectTab) => void;
}

/** The Overview, Updates and Issues tabs under the page title. */
const TabBar: React.FC<TabBarProps> = ({ tab, issueCount, onChange }) => (
  <div role="tablist" aria-label="Project" className="flex items-center gap-1">
    {TABS.map((value) => (
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
        {TAB_LABELS[value]}
        {value === 'issues' && (
          <span className="text-text-faint tabular-nums">
            {String(issueCount)}
          </span>
        )}
      </button>
    ))}
  </div>
);

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
    refetch: refetchTeams,
  } = useTeam(undefined);
  const projectId = id ?? '';
  const tab = tabFrom(params.get('tab'));
  const [composing, setComposing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [deletingMilestone, setDeletingMilestone] =
    useState<MilestoneRead | null>(null);

  const detailKey = projectDetailKey(workspaceId, projectId);
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
    refetch,
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
    invalidate: [detailKey, listKey, initiativesKey(workspaceId, '')],
    failureMessage: (failure) =>
      errorMessage(
        failure,
        'Could not update the project. It has been undone.'
      ),
  });

  const closePrompt = useCloseProjectPrompt({ workspaceId, project, update });
  const projectLabels = useProjectLabels(workspaceId);

  const serverTeamIds = project?.team_ids;
  const teamIds = useMemo(() => serverTeamIds ?? [], [serverTeamIds]);
  const { statuses, labels, people } = usePlanningTeamLists(
    workspaceId,
    teamIds
  );
  const breakdownContext = useMemo(
    () => ({ labels, people, projects: [] }),
    [labels, people]
  );
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

  const updates = useProjectUpdates(workspaceId, projectId, project !== null);
  const history = useProjectHistory(workspaceId, projectId, project !== null);
  const dependencies = useProjectDependencies(workspaceId, project);
  const { projects: workspaceProjects } = useWorkspaceProjects(
    workspaceId,
    '',
    project !== null
  );
  const dependencyCandidates = useMemo(
    () =>
      workspaceProjects.filter(
        (candidate) => candidate.project_id !== projectId
      ),
    [workspaceProjects, projectId]
  );
  const updateTemplates = useDocumentTemplates(
    workspaceId,
    'project',
    projectId,
    project !== null
  );
  const { initiatives } = useInitiatives(
    workspaceId,
    project !== null && workspace?.role !== 'guest'
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
  const propertiesRow = useRef<HTMLDivElement>(null);
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

  const setTab = useCallback(
    (next: ProjectTab): void => {
      setParams(
        (current) => {
          const held = new URLSearchParams(current);
          if (next === 'overview') held.delete('tab');
          else held.set('tab', next);
          return held;
        },
        { replace: true }
      );
    },
    [setParams]
  );

  const mayPost =
    project !== null && canEditProject(workspace?.role, project, teams);
  const writeUpdate = useCallback((): void => {
    setTab('updates');
    setComposing(true);
  }, [setTab]);
  useShortcut({
    keys: 'shift+u',
    label: 'Post project update',
    scope: 'page',
    group: 'Project',
    enabled: mayPost,
    handler: (event) => {
      event?.preventDefault();
      writeUpdate();
    },
  });
  useCreateDocumentCommand({
    workspaceId,
    slug,
    parentKind: 'project',
    parentId: projectId,
    group: 'Project',
    enabled: mayPost,
  });

  const linkWrite = async (
    write: () => Promise<unknown>,
    fallback: string
  ): Promise<void> => {
    try {
      await write();
    } catch (failure) {
      showErrorToast(errorMessage(failure, fallback));
      throw failure;
    }
    void refetch();
  };

  const viewState = useMemo(
    () => parseViewState(params, PROJECT_VIEW_BASE),
    [params]
  );
  const activeFilters = useMemo(() => {
    const held: Partial<Record<BreakdownField, string[]>> = {};
    for (const clause of viewState.filters) {
      if (
        clause.op === 'is' &&
        (clause.field === 'assignee' ||
          clause.field === 'label' ||
          clause.field === 'priority')
      ) {
        held[clause.field as BreakdownField] = clause.values;
      }
    }
    return held;
  }, [viewState.filters]);
  const filterIssuesBy = (
    field: BreakdownField,
    value: string | null,
    milestoneId: string | null
  ): void => {
    if (value === null) {
      setParams(
        writeViewState(
          {
            ...viewState,
            filters: viewState.filters.filter(
              (clause) => clause.field !== field
            ),
          },
          PROJECT_VIEW_BASE,
          params
        ),
        { replace: true }
      );
      return;
    }
    let filters = narrowFilters(
      viewState.filters,
      field,
      filterValuesFor(field, value, { statuses, labels })
    );
    if (milestoneId !== null) {
      filters = narrowFilters(filters, 'milestone', [milestoneId]);
    }
    const held = writeViewState(
      { ...viewState, filters },
      PROJECT_VIEW_BASE,
      params
    );
    held.set('tab', 'issues');
    setParams(held);
  };

  const openMilestoneIssues = (milestoneId: string): void => {
    const held = new URLSearchParams(params);
    held.set('tab', 'issues');
    held.delete('f');
    held.append('f', `milestone.is:${milestoneId}`);
    setParams(held);
  };

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

  if (isResolving && teamsError !== null && teamsError !== undefined) {
    return (
      <WorkspaceShell title="Project" leading={crumbs}>
        <LoadError
          message={errorMessage(teamsError, 'Could not load the teams.')}
          onRetry={() => {
            void refetchTeams();
          }}
        />
      </WorkspaceShell>
    );
  }

  if (isResolving || (isLoading && project === null)) {
    return (
      <WorkspaceShell title="Project" leading={crumbs}>
        <SkeletonRows label="Loading project" />
      </WorkspaceShell>
    );
  }

  if (
    project === null &&
    error !== null &&
    error !== undefined &&
    !hasStatus(error, NOT_FOUND)
  ) {
    return (
      <WorkspaceShell title="Project" leading={crumbs}>
        <LoadError
          message={errorMessage(error, 'Could not load this project.')}
          onRetry={() => {
            void refetch();
          }}
        />
      </WorkspaceShell>
    );
  }

  if (project === null) {
    return (
      <WorkspaceShell title="Project not found" leading={crumbs}>
        <EmptyState message="That project does not exist, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const canEdit = canEditProject(workspace?.role, project, teams);
  const canDelete =
    isTeamAdmin(workspace?.role, undefined) ||
    projectTeams.some((team) => isTeamAdmin(workspace?.role, team.role));
  const percent = progressPercent(project);
  const nudge = updateNudge(project);
  const workspaceCadence = workspace?.project_update_interval_days ?? 7;
  const latestAuthor =
    updates.latest === null
      ? undefined
      : personLabel(
          people.find((person) => person.user_id === updates.latest?.author_id)
        );

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

  const archived = project.archived_at != null;
  const toggleArchived = (): void => {
    (archived ? unarchiveProject : archiveProject)(workspaceId, projectId).then(
      () => {
        invalidateQueries(detailKey);
        invalidateQueries(listKey);
        showToast(`${archived ? 'Restored' : 'Archived'} ${project.name}`);
      },
      (failure: unknown) => {
        showErrorToast(
          errorMessage(
            failure,
            archived
              ? 'Could not restore this project.'
              : 'Could not archive this project.'
          )
        );
      }
    );
  };

  const properties = (
    <div
      ref={propertiesRow}
      role="group"
      aria-label="Properties"
      className="flex flex-wrap items-center gap-1.5"
    >
      <ProjectStatusPicker
        variant="chip"
        value={project.status}
        statusId={project.status_id}
        percent={percent}
        disabled={!canEdit}
        onChange={closePrompt.changeStatus}
      />
      <HealthPicker
        variant="chip"
        value={project.health}
        disabled={!canEdit}
        onChange={(health) => {
          void update({ health });
        }}
      />
      <PriorityPicker
        variant="chip"
        value={project.priority}
        disabled={!canEdit}
        onChange={(priority) => {
          void update({ priority });
        }}
      />
      <LeadPicker
        variant="chip"
        value={project.lead_id}
        people={people}
        disabled={!canEdit}
        onChange={(leadId) => {
          void update({ lead_id: leadId });
        }}
      />
      <MembersPicker
        variant="chip"
        value={project.member_ids}
        people={people}
        disabled={!canEdit}
        onChange={(memberIds) => {
          void update({ member_ids: memberIds });
        }}
      />
      <ProjectLabelsPicker
        variant="chip"
        value={project.label_ids ?? []}
        labels={projectLabels.labels}
        disabled={!canEdit}
        onChange={(labelIds) => {
          void update({ label_ids: labelIds });
        }}
      />
      <span className="inline-flex items-center gap-1">
        <PlanningDatePicker
          variant="chip"
          field="Start date"
          edge="start"
          value={project.start_date}
          resolution={project.start_date_resolution}
          disabled={!canEdit}
          icon={<LuCalendar className="h-3.5 w-3.5" />}
          {...(project.target_date === null
            ? {}
            : { max: project.target_date })}
          onChange={(value, resolution) => {
            void update({
              start_date: value,
              ...(isCoarse(resolution)
                ? { start_date_resolution: resolution }
                : {}),
            });
          }}
        />
        <LuArrowRight
          aria-hidden="true"
          className="h-3 w-3 shrink-0 text-text-faint"
        />
        <PlanningDatePicker
          variant="chip"
          field="Target date"
          edge="end"
          value={project.target_date}
          resolution={project.target_date_resolution}
          disabled={!canEdit}
          icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
          {...(project.start_date === null ? {} : { min: project.start_date })}
          onChange={(value, resolution) => {
            void update({
              target_date: value,
              ...(isCoarse(resolution)
                ? { target_date_resolution: resolution }
                : {}),
            });
          }}
        />
      </span>
      <DependencyPicker
        type="blocked_by"
        value={dependencies.sides.blocked_by}
        opposite={dependencies.sides.blocks}
        candidates={dependencyCandidates}
        disabled={!canEdit}
        onToggle={(targetId) => {
          dependencies.toggle('blocked_by', targetId);
        }}
      />
      <DependencyPicker
        type="blocks"
        value={dependencies.sides.blocks}
        opposite={dependencies.sides.blocked_by}
        candidates={dependencyCandidates}
        disabled={!canEdit}
        onToggle={(targetId) => {
          dependencies.toggle('blocks', targetId);
        }}
      />
      <CadencePicker
        variant="chip"
        value={project.update_interval_days ?? workspaceCadence}
        inherited={project.update_interval_inherited ?? true}
        workspaceDefault={workspaceCadence}
        disabled={!canEdit}
        onChange={(interval) => {
          void update({ update_interval_days: interval });
        }}
      />
      <TeamsPicker
        variant="chip"
        value={project.team_ids}
        teams={teams}
        disabled={!canEdit}
        onChange={(next) => {
          if (next.length > 0) void update({ team_ids: next });
        }}
      />
      {workspace?.role !== 'guest' && (
        <InitiativePicker
          variant="chip"
          value={project.initiative_id ?? null}
          initiatives={initiatives}
          disabled={!canEdit}
          onChange={(initiativeId) => {
            void update({ initiative_id: initiativeId });
          }}
        />
      )}
    </div>
  );

  return (
    <WorkspaceShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <ProjectIcon icon={project.icon} color={project.color} />
          <span className="truncate">{project.name}</span>
          <UpdateDueBadge project={project} className="shrink-0" />
        </span>
      }
      titleAccessory={
        <FavoriteButton
          workspaceId={workspaceId}
          kind="project"
          targetId={project.project_id}
          title={project.name}
        />
      }
      leading={crumbs}
      flush
      toolbar={
        <TabBar tab={tab} issueCount={project.counts.total} onChange={setTab} />
      }
      actions={
        <div className="flex items-center gap-1">
          <FollowButton
            workspaceId={workspaceId}
            subject="project"
            subjectId={project.project_id}
          />
          {mayCreate && (
            <Button variant="secondary" size="sm" onClick={createIssue}>
              <LuPlus aria-hidden="true" />
              New issue
            </Button>
          )}
          {(canEdit || canDelete) && (
            <Menu
              label="Project actions"
              align="end"
              trigger={(trigger) => (
                <IconButton label="Project actions" size="sm" {...trigger}>
                  <LuEllipsis className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              {canEdit && (
                <MenuItem onSelect={toggleArchived}>
                  {archived ? (
                    <LuArchiveRestore
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                    />
                  ) : (
                    <LuArchive aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {archived ? 'Restore project' : 'Archive project'}
                </MenuItem>
              )}
              {canDelete && (
                <MenuItem
                  danger
                  onSelect={() => {
                    setIsConfirmingDelete(true);
                  }}
                >
                  <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  Delete project
                </MenuItem>
              )}
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
      {archived && (
        <div
          role="status"
          className="flex items-center gap-3 border-b border-line bg-raised px-4 py-2 text-sm text-text-muted lg:px-6"
        >
          <LuArchive aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            This project is archived. It is hidden from the projects list.
          </span>
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={toggleArchived}>
              Restore
            </Button>
          )}
        </div>
      )}
      {tab === 'updates' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DocumentLinkContext.Provider
            value={{ kind: 'project', id: projectId }}
          >
            <ProjectUpdatesFeed
              feed={updates}
              people={people}
              canPost={canEdit}
              defaultHealth={project.health ?? 'on_track'}
              dueState={project.update_due_state ?? null}
              dueAt={project.next_update_due_at ?? null}
              composing={composing}
              onComposingChange={setComposing}
              templates={updateTemplates.templates}
              defaultTemplate={updateTemplates.defaultUpdate}
            />
          </DocumentLinkContext.Provider>
        </div>
      ) : tab === 'issues' ? (
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
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 lg:flex-row lg:px-8">
            <div className="min-w-0 flex-1 space-y-8">
              <div className="space-y-3">
                <ProjectLookPicker
                  icon={project.icon}
                  color={project.color}
                  disabled={!canEdit}
                  className="h-8 w-8 [&>svg]:h-5 [&>svg]:w-5"
                  onChange={(patch) => {
                    void update(patch);
                  }}
                />
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
                {properties}
                <ProjectPropertyKeys
                  container={propertiesRow}
                  enabled={canEdit}
                />
                {nudge !== null && (
                  <div
                    role="status"
                    className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs text-text-muted"
                  >
                    <LuPencilLine
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 text-warning"
                    />
                    <span className="min-w-0 flex-1">{nudge}</span>
                    {canEdit && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={writeUpdate}
                      >
                        Write update
                      </Button>
                    )}
                  </div>
                )}
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
              <ProjectResources
                links={project.links ?? []}
                canEdit={canEdit}
                onCreate={(body) =>
                  linkWrite(
                    () => createProjectLink(workspaceId, projectId, body),
                    'Could not add the link.'
                  )
                }
                onUpdate={(linkId, patch) =>
                  linkWrite(
                    () =>
                      updateProjectLink(workspaceId, projectId, linkId, patch),
                    'Could not update the link.'
                  )
                }
                onRemove={(link) =>
                  linkWrite(
                    () =>
                      deleteProjectLink(workspaceId, projectId, link.link_id),
                    'Could not remove the link.'
                  ).catch(() => undefined)
                }
              />
              <DocumentsSection
                workspaceId={workspaceId}
                slug={slug}
                parentKind="project"
                parentId={projectId}
                canCreate={canEdit}
                people={people}
              />
              {workspace?.role !== 'guest' && (
                <CustomerRequestsSection
                  workspaceId={workspaceId}
                  slug={slug}
                  targetKind="project"
                  targetId={projectId}
                  targetLabel={project.name}
                  canAdd={canEdit}
                  variant="section"
                />
              )}
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
              <ProjectActivityFeed
                workspaceId={workspaceId}
                projectId={projectId}
                people={people}
                teams={teams}
                initiatives={initiatives}
                milestones={milestones.milestones}
                projectLabels={projectLabels.labels}
                updates={updates.updates}
                updatesHaveMore={updates.hasMore}
                onLoadMoreUpdates={updates.loadMore}
                onOpenUpdates={() => {
                  setTab('updates');
                }}
              />
            </div>
            <ProjectProgressPanel
              project={project}
              teams={teams}
              issues={issues.rows}
              statuses={statuses}
              complete={!issues.isLoading && !issues.hasMore}
              milestones={milestones.milestones}
              onOpenMilestone={openMilestoneIssues}
              context={breakdownContext}
              isLoadingIssues={issues.isLoading}
              activeFilters={activeFilters}
              onFilter={filterIssuesBy}
              latestUpdate={updates.latest}
              history={history}
              {...(latestAuthor === undefined ? {} : { latestAuthor })}
              onOpenUpdates={() => {
                setTab('updates');
              }}
            />
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

      {closePrompt.dialog}

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
