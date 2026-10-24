/**
 * Every project in the workspace, laid out as a dense list, a board or a
 * timeline. The list shows icon and name with its blocked and blocking flags,
 * health, priority, status, lead, start and target dates, teams and progress,
 * and edits health, priority, status, lead and both dates from the row
 * without opening it. The board puts projects in columns by
 * the grouping and moves them between columns by dragging; the timeline draws
 * them as bars from start to target date. Rows group by status, health,
 * priority, initiative, lead or team, order by date, name, priority or
 * progress, and completed projects show for all time, a recent window or not
 * at all. The arrangement is saved to the account and carried in the URL so
 * an arranged page can be shared. Filtered to a parent team, the page
 * includes the projects of its visible sub-teams, with the issue list's
 * toggle to show the team alone. The arrangement and filters save as a view
 * of projects, and opened as that view the page starts from what it stores,
 * keeps changes in the URL until they are saved over it or as a new view,
 * and leaves the account's own arrangement alone.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuBookmarkPlus,
  LuChevronRight,
  LuListFilter,
  LuPencil,
  LuPlus,
  LuTarget,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { updateProject } from '../../api/planning';
import {
  createView,
  updateView,
  type SavedViewDisplayRead,
  type SavedViewFilter,
} from '../../api/views';
import {
  SaveViewDialog,
  refreshViewLists,
  type ViewDetails,
} from '../../components/issues/view/IssueViewPage';
import CreateProjectDialog from '../../components/planning/CreateProjectDialog';
import ProgressRing from '../../components/planning/ProgressRing';
import {
  DatePicker,
  PriorityPicker,
} from '../../components/issues/PropertyPickers';
import {
  HealthPicker,
  LeadPicker,
  ProjectStatusPicker,
  TeamKey,
} from '../../components/planning/ProjectPickers';
import ProjectDependencyMarkers from '../../components/planning/ProjectDependencyMarkers';
import ProjectGroupGlyph from '../../components/planning/ProjectGroupGlyph';
import UpdateDueBadge from '../../components/planning/UpdateDueBadge';
import ProjectIcon from '../../components/planning/ProjectIcon';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import ProjectsBoard from '../../components/planning/ProjectsBoard';
import ProjectsDisplayMenu from '../../components/planning/ProjectsDisplayMenu';
import ProjectTimeline, {
  TimelineControls,
  type ProjectTimelineHandle,
} from '../../components/planning/ProjectTimeline';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox';
import EmptyState from '../../components/ui/empty-state';
import FavoriteButton from '../../components/ui/FavoriteButton';
import { Popover } from '../../components/ui/popover';
import { SkeletonRows } from '../../components/ui/skeleton';
import SubTeamToggle from '../../components/workspace/SubTeamToggle';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import useCloseProjectPrompt from '../../hooks/useCloseProjectPrompt';
import { useInitiatives } from '../../hooks/useInitiatives';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useProjectMoves } from '../../hooks/useProjectMoves';
import { useProjectsDisplay } from '../../hooks/useProjectsDisplay';
import { useTeam } from '../../hooks/useTeam';
import { useTimelineShortcuts } from '../../hooks/useTimelineShortcuts';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { ROLL_UP_PARAM, useSubTeamRollUp } from '../../hooks/useSubTeamRollUp';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { sharedChange, viewVisibility } from '../../lib/issueView';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectPath, viewPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  progressPercent,
} from '../../lib/planningDisplay';
import { PROJECT_STATUS_ORDER, canEditProject } from '../../lib/planningModel';
import {
  PROJECTS_DISPLAY_FIELDS,
  groupProjects,
  groupValue,
  sortProjects,
  withinClosedWindow,
  type ProjectGroup,
} from '../../lib/projectList';
import {
  orderedStatuses,
  projectViewBase,
  sameProjectFilter,
  toProjectViewFilter,
} from '../../lib/projectView';
import { viewKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  ProjectRead,
  ProjectStatus,
  ProjectUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import { teamTree } from '../../lib/teamOrder';
import type { TimelineZoom } from '../../lib/timeline';

/** The grid every header and row lines up on. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_7rem_2rem_8.5rem_2rem_6rem_6rem_6rem_4.5rem]';

/** The statuses a closed project holds, hidden as board columns with completed projects. */
const CLOSED_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  'completed',
  'canceled',
]);

/** The filter value that asks for projects with no lead. */
const NO_LEAD = 'none';

/** Props for FilterButton: one filter's options and what is chosen. */
interface FilterButtonProps {
  field: string;
  options: ComboboxOption[];
  selected: string[];
  multiple?: boolean;
  onSelect: (value: string) => void;
}

/** A toolbar chip that opens one filter's options. */
const FilterButton: React.FC<FilterButtonProps> = ({
  field,
  options,
  selected,
  multiple = false,
  onSelect,
}) => {
  const chosen = options.filter((option) => selected.includes(option.value));
  const summary =
    chosen.length === 0
      ? null
      : chosen.length === 1
        ? (chosen[0]?.label ?? '')
        : `${String(chosen.length)} selected`;
  return (
    <Popover
      label={field}
      contentClassName="w-60"
      trigger={(trigger) => (
        <button
          type="button"
          {...trigger}
          aria-label={`${field} filter${summary === null ? '' : `: ${summary}`}`}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-sm border px-2 text-xs transition-colors duration-100',
            summary === null
              ? 'border-dashed border-line text-text-muted hover:border-line-strong hover:text-text'
              : 'border-line bg-raised text-text hover:border-line-strong'
          )}
        >
          <span className={summary === null ? '' : 'text-text-muted'}>
            {field}
          </span>
          {summary !== null && <span className="font-medium">{summary}</span>}
        </button>
      )}
    >
      {(close) => (
        <Combobox
          label={field}
          placeholder={`Filter by ${field.toLowerCase()}`}
          options={options}
          selected={selected}
          multiple={multiple}
          onSelect={(value) => {
            onSelect(value);
            if (!multiple) close();
          }}
        />
      )}
    </Popover>
  );
};

/** Props for ProjectRow: one project and what the row needs to edit it. */
interface ProjectRowProps {
  project: ProjectRead;
  slug: string;
  workspaceId: string;
  teams: TeamRead[];
  people: Assignable[];
  /** Every loaded project by id, so the dependency flags can name their projects. */
  byId: ReadonlyMap<string, ProjectRead>;
  workspaceRole: WorkspaceRole | undefined;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
  refreshKey: ReturnType<typeof useWorkspaceProjects>['queryKey'];
}

/**
 * One project as a table row. The whole row opens the project; the health,
 * priority, status, lead and date cells sit above that link and edit in
 * place, optimistically.
 */
const ProjectRow: React.FC<ProjectRowProps> = ({
  project: server,
  slug,
  workspaceId,
  teams,
  people,
  byId,
  workspaceRole,
  isActive,
  rowRef,
  onPointerEnter,
  refreshKey,
}) => {
  const { value, update } = useOptimisticRecord<ProjectRead, ProjectUpdate>(
    server,
    {
      write: (patch) => updateProject(workspaceId, server.project_id, patch),
      isSame: (left, right) => left.project_id === right.project_id,
      invalidate: refreshKey,
      failureMessage: (error) =>
        errorMessage(
          error,
          'Could not update that project. It has been undone.'
        ),
    }
  );
  const project = value ?? server;
  const closePrompt = useCloseProjectPrompt({ workspaceId, project, update });
  const percent = progressPercent(project);
  const editable = canEditProject(workspaceRole, project, teams);
  const projectTeams = teams.filter((team) =>
    project.team_ids.includes(team.id)
  );
  const lead = people.find((person) => person.user_id === project.lead_id);
  const href = projectPath(slug, project.project_id);

  return (
    <li
      ref={rowRef}
      onPointerEnter={onPointerEnter}
      className={cn(
        GRID,
        'relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6',
        isActive && 'bg-surface'
      )}
    >
      <Link
        to={href}
        aria-label={project.name}
        data-hover="parent"
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
        <ProjectIcon icon={project.icon} color={project.color} />
        <span className="truncate font-medium text-text">{project.name}</span>
        <ProjectDependencyMarkers project={project} byId={byId} />
        <UpdateDueBadge project={project} className="shrink-0" />
        {project.description !== null && project.description !== '' && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint xl:block">
            {project.description.split('\n')[0]}
          </span>
        )}
      </div>
      <div className="relative z-10 hidden md:block">
        <HealthPicker
          variant="rail"
          value={project.health}
          disabled={!editable}
          onChange={(health) => {
            void update({ health });
          }}
        />
      </div>
      <div className="relative z-10 hidden min-w-0 justify-center md:flex">
        <PriorityPicker
          variant="icon"
          value={project.priority}
          disabled={!editable}
          onChange={(priority) => {
            void update({ priority });
          }}
        />
      </div>
      <div className="relative z-10 hidden md:block">
        <ProjectStatusPicker
          variant="rail"
          value={project.status}
          percent={percent}
          disabled={!editable}
          onChange={closePrompt.changeStatus}
        />
      </div>
      <div className="relative z-10 hidden min-w-0 justify-center md:flex">
        <LeadPicker
          variant="icon"
          value={project.lead_id}
          people={people}
          disabled={!editable}
          onChange={(leadId) => {
            void update({ lead_id: leadId });
          }}
        />
      </div>
      <div className="relative z-10 hidden min-w-0 tabular-nums md:block">
        <DatePicker
          variant="rail"
          field="Start date"
          icon={null}
          emptyLabel="No date"
          value={project.start_date}
          disabled={!editable}
          {...(project.target_date === null
            ? {}
            : { max: project.target_date })}
          onChange={(start) => {
            void update({ start_date: start });
          }}
        />
      </div>
      <div className="relative z-10 hidden min-w-0 tabular-nums md:block">
        <DatePicker
          variant="rail"
          field="Target date"
          icon={null}
          emptyLabel="No date"
          value={project.target_date}
          disabled={!editable}
          {...(project.start_date === null ? {} : { min: project.start_date })}
          onChange={(target) => {
            void update({ target_date: target });
          }}
        />
      </div>
      <span className="pointer-events-none hidden min-w-0 items-center gap-1 md:flex">
        {projectTeams.slice(0, 3).map((team) => (
          <TeamKey key={team.id} keyPrefix={team.key_prefix} />
        ))}
        {projectTeams.length > 3 && (
          <span className="text-2xs text-text-faint">
            +{String(projectTeams.length - 3)}
          </span>
        )}
        <span className="sr-only">
          {projectTeams.map((team) => team.name).join(', ')}
        </span>
      </span>
      <span className="pointer-events-none flex items-center justify-end gap-1.5 text-xs text-text-muted tabular-nums">
        <ProgressRing percent={percent} />
        <span>{`${String(percent)}%`}</span>
      </span>
      {lead !== undefined && (
        <span className="sr-only">{`Lead ${personLabel(lead)}`}</span>
      )}
      {closePrompt.dialog}
    </li>
  );
};

/** Which dialog is open over the page, saving a new view or editing the open one. */
type Saving = 'new' | 'details' | null;

/** The filters the page keeps in the URL. */
type FilterField = 'team' | 'status' | 'lead';

/** Props for Projects. */
export interface ProjectsProps {
  /** A view of projects the page opens as, its stored filters and arrangement the base. */
  view?: SavedViewDisplayRead;
  /** What sits before the title, the way back to the views list for a view. */
  leading?: React.ReactNode;
}

/** The projects of the whole workspace, grouped, filtered and editable. */
export const Projects: React.FC<ProjectsProps> = ({ view, leading }) => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const slug = workspace?.slug ?? '';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const {
    teams,
    workspaceId,
    isLoading: isResolvingTeams,
    error: teamsError,
  } = useTeam(undefined);
  const [saving, setSaving] = useState<Saving>(null);
  const [updating, setUpdating] = useState(false);

  const base = useMemo(
    () => (view === undefined ? undefined : projectViewBase(view, teams)),
    [view, teams]
  );
  const baseOf = useCallback(
    (field: FilterField): string =>
      base === undefined
        ? ''
        : field === 'team'
          ? base.team
          : field === 'status'
            ? base.status.join(',')
            : base.lead,
    [base]
  );
  const teamFilter = params.get('team') ?? baseOf('team');
  const statusText = params.get('status') ?? baseOf('status');
  const statusFilter = useMemo(
    () =>
      statusText
        .split(',')
        .filter((value): value is ProjectStatus =>
          PROJECT_STATUS_ORDER.includes(value as ProjectStatus)
        ),
    [statusText]
  );
  const leadFilter = params.get('lead') ?? baseOf('lead');
  const {
    display,
    change: changeDisplay,
    reset,
  } = useProjectsDisplay(base?.display);
  const { layout, group: grouping, order: ordering, closed, zoom } = display;
  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);
  const baseRollUp = base?.rollUp ?? true;
  const {
    subTeams,
    rollUp,
    toggle: toggleRollUp,
  } = useSubTeamRollUp(filteredTeam, true, baseRollUp);
  const heldRollUp = params.get(ROLL_UP_PARAM);
  const savedFilter = toProjectViewFilter({
    teamId:
      filteredTeam?.id ??
      (base !== undefined && teamFilter === base.team ? base.teamId : ''),
    status: statusFilter,
    lead: leadFilter,
    rollUp: heldRollUp === null ? baseRollUp : heldRollUp !== '0',
  });
  const changed =
    base !== undefined &&
    (!sameProjectFilter(savedFilter, toProjectViewFilter(base)) ||
      PROJECTS_DISPLAY_FIELDS.some(
        (field) => display[field] !== base.display[field]
      ));

  const { projects, error, isLoading, queryKey } = useWorkspaceProjects(
    workspaceId,
    filteredTeam?.id ?? '',
    !isResolvingTeams && (teamFilter === '' || filteredTeam !== undefined),
    rollUp
  );
  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.project_id, project])),
    [projects]
  );
  const { people } = usePlanningTeamLists(workspaceId, teamIds, {
    statuses: false,
    labels: false,
  });

  const { initiatives } = useInitiatives(
    workspaceId,
    grouping === 'initiative'
  );
  const { apply: applyMoves, move: moveProject } = useProjectMoves(
    workspaceId,
    queryKey
  );
  const [now] = useState(() => new Date());
  const timeline = useRef<ProjectTimelineHandle | null>(null);

  const [creating, setCreating] = useState<ProjectStatus | null>(null);
  const [folded, setFolded] = useState<string[]>([]);
  const toggleFolded = (key: string): void => {
    setFolded((held) =>
      held.includes(key)
        ? held.filter((value) => value !== key)
        : [...held, key]
    );
  };

  const writableTeams = useMemo(
    () => teams.filter((team) => canWriteIssues(workspace?.role, team.role)),
    [teams, workspace?.role]
  );
  const canCreate = writableTeams.length > 0;

  const rows = useMemo(
    () =>
      applyMoves(projects)
        .filter(
          (project) =>
            statusFilter.length === 0 || statusFilter.includes(project.status)
        )
        .filter((project) =>
          leadFilter === ''
            ? true
            : leadFilter === NO_LEAD
              ? project.lead_id === null
              : project.lead_id === leadFilter
        )
        .filter((project) => withinClosedWindow(project, closed, now)),
    [applyMoves, projects, statusFilter, leadFilter, closed, now]
  );

  const sorted = useMemo(() => sortProjects(rows, ordering), [rows, ordering]);
  const groups = useMemo(
    () => groupProjects(sorted, grouping, people, teams, { initiatives }),
    [sorted, grouping, people, teams, initiatives]
  );
  const columns = useMemo(
    () =>
      layout !== 'board'
        ? []
        : groupProjects(sorted, grouping, people, teams, {
            initiatives,
            keepEmpty: true,
          }).filter((column) => {
            if (column.kind !== 'status') return true;
            const status = groupValue(column) as ProjectStatus;
            if (statusFilter.length > 0) return statusFilter.includes(status);
            return closed !== 'none' || !CLOSED_STATUSES.has(status);
          }),
    [layout, sorted, grouping, people, teams, initiatives, statusFilter, closed]
  );
  const isOpen = useCallback(
    (group: ProjectGroup) =>
      group.kind === 'none' || !folded.includes(group.key),
    [folded]
  );
  const visible = useMemo(
    () => groups.filter(isOpen).flatMap((group) => group.rows),
    [groups, isOpen]
  );
  const starts = useMemo(
    () =>
      groups.map((_, index) =>
        groups
          .slice(0, index)
          .filter(isOpen)
          .reduce((sum, group) => sum + group.rows.length, 0)
      ),
    [groups, isOpen]
  );

  const onActivate = useCallback(
    (index: number) => {
      const project = visible[index];
      if (project !== undefined)
        void navigate(projectPath(slug, project.project_id));
    },
    [visible, navigate, slug]
  );

  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: visible.length,
    onActivate,
    resetKey: `${params.toString()}:${folded.join(',')}:${String(rows.length)}`,
    enabled: creating === null && layout === 'list',
  });

  const writeParam = (
    next: URLSearchParams,
    field: FilterField,
    value: string
  ): void => {
    if (value === baseOf(field)) next.delete(field);
    else next.set(field, value);
  };

  const setParam = (field: FilterField, value: string): void => {
    const next = new URLSearchParams(params);
    writeParam(next, field, value);
    setParams(next, { replace: true });
  };

  const saveNew = async (details: ViewDetails): Promise<void> => {
    const shareWith = details.shared ? details.teamId : undefined;
    try {
      const created = await createView(workspaceId, {
        name: details.name,
        kind: 'list',
        entity: 'projects',
        filter: savedFilter as unknown as SavedViewFilter,
        projects_display: display,
        ...(shareWith === undefined ? {} : { team_id: shareWith }),
        ...(shareWith === undefined && details.shared ? { shared: true } : {}),
        ...details.look,
      });
      refreshViewLists(workspaceId, details.teamId);
      setSaving(null);
      showToast(`Saved view ${created.name}.`);
      void navigate(viewPath(slug, created.view_id));
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not save the view.'));
    }
  };

  const saveDetails = async (details: ViewDetails): Promise<void> => {
    if (view === undefined) return;
    try {
      await updateView(workspaceId, view.view_id, {
        name: details.name,
        ...details.look,
        ...sharedChange(view, details.shared),
      });
      invalidateQueries(viewKey(workspaceId, view.view_id));
      refreshViewLists(workspaceId, view.team_id ?? undefined);
      setSaving(null);
      showToast('View updated.');
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not update the view.'));
    }
  };

  const saveOver = async (): Promise<void> => {
    if (view === undefined) return;
    setUpdating(true);
    try {
      await updateView(workspaceId, view.view_id, {
        filter: savedFilter as unknown as SavedViewFilter,
        projects_display: display,
      });
      invalidateQueries(viewKey(workspaceId, view.view_id));
      refreshViewLists(workspaceId, view.team_id ?? undefined);
      showToast('View updated.');
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not update the view.'));
    } finally {
      setUpdating(false);
    }
  };

  const discard = (): void => {
    setParams(new URLSearchParams(), { replace: true });
  };

  const toggleStatus = (status: string): void => {
    const held = statusFilter as string[];
    setParam(
      'status',
      orderedStatuses(
        held.includes(status)
          ? held.filter((value) => value !== status)
          : [...held, status]
      ).join(',')
    );
  };

  const hasFilters =
    teamFilter !== '' || statusFilter.length > 0 || leadFilter !== '';

  useShortcut({
    keys: 'shift+p',
    label: 'New project',
    group: 'Projects',
    enabled: canCreate && creating === null,
    handler: (event) => {
      event?.preventDefault();
      setCreating('planned');
    },
  });

  useShortcut({
    keys: 'shift+v',
    label: 'Save as view',
    scope: 'page',
    group: 'Projects',
    enabled: saving === null && creating === null,
    handler: () => {
      setSaving('new');
    },
  });

  useShortcut({
    keys: 'mod+s',
    label: 'Save view changes',
    scope: 'page',
    group: 'Projects',
    enabled: changed && !updating && saving === null,
    handler: (event) => {
      event?.preventDefault();
      void saveOver();
    },
  });

  useShortcut({
    keys: 'shift+g',
    label: 'Toggle grouping',
    group: 'Projects',
    handler: () => {
      changeDisplay({ group: grouping === 'none' ? 'status' : 'none' });
    },
  });

  const timelineControls = {
    zoom,
    onZoomChange: (value: TimelineZoom) => {
      changeDisplay({ zoom: value });
    },
    onToday: () => {
      timeline.current?.scrollToToday();
    },
  };
  useTimelineShortcuts({
    ...timelineControls,
    group: 'Projects',
    enabled: layout === 'timeline',
  });

  const statusOptions: ComboboxOption[] = PROJECT_STATUS_ORDER.map(
    (status) => ({
      value: status,
      label: PROJECT_STATUS_LABELS[status],
      icon: <ProjectStatusGlyph status={status} />,
    })
  );
  const leadOptions: ComboboxOption[] = [
    { value: NO_LEAD, label: 'No lead' },
    ...people.map((person) => ({
      value: person.user_id,
      label: personLabel(person),
      icon: (
        <Avatar
          name={personLabel(person)}
          src={personAvatar(person)}
          size="xs"
        />
      ),
      keywords: [person.email],
    })),
  ];
  const teamOptions: ComboboxOption[] = teamTree(teams).map(
    ({ team, nested, parentName }) => ({
      value: team.key_prefix,
      label: team.name,
      icon: <TeamKey keyPrefix={team.key_prefix} />,
      indent: nested,
      ...(parentName === undefined ? {} : { keywords: [parentName] }),
    })
  );

  const initialTeamIds =
    filteredTeam !== undefined && writableTeams.includes(filteredTeam)
      ? [filteredTeam.id]
      : writableTeams[0] === undefined
        ? []
        : [writableTeams[0].id];

  const showSkeleton =
    teamsError === null && (isResolvingTeams || isLoading) && rows.length === 0;

  const saveBar = !changed ? null : (
    <div
      role="region"
      aria-label="Unsaved view changes"
      className="flex w-full flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs"
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
      />
      <span className="text-text-muted">Unsaved changes</span>
      <span className="flex-1" />
      <Button size="sm" variant="ghost" onClick={discard}>
        Discard
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setSaving('new');
        }}
      >
        Save as new
      </Button>
      <Button
        size="sm"
        variant="primary"
        disabled={updating}
        onClick={() => void saveOver()}
      >
        Save
      </Button>
    </div>
  );

  return (
    <WorkspaceShell
      title={view?.name ?? 'Projects'}
      {...(leading === undefined ? {} : { leading })}
      {...(view === undefined
        ? {}
        : {
            titleAccessory: (
              <FavoriteButton
                workspaceId={workspaceId}
                kind="view"
                targetId={view.view_id}
                title={view.name}
              />
            ),
          })}
      flush
      actions={
        <div className="flex items-center gap-1.5">
          {view === undefined ? (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => {
                setSaving('new');
              }}
            >
              <LuBookmarkPlus aria-hidden="true" className="h-3.5 w-3.5" />
              Save as view
            </Button>
          ) : (
            <IconButton
              label="Edit view details"
              size="sm"
              onClick={() => {
                setSaving('details');
              }}
            >
              <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
            </IconButton>
          )}
          {canCreate && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setCreating('planned');
              }}
            >
              <LuPlus aria-hidden="true" />
              New project
            </Button>
          )}
        </div>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-1.5">
          <LuListFilter
            aria-hidden="true"
            className="mr-0.5 h-3.5 w-3.5 text-text-faint"
          />
          <FilterButton
            field="Status"
            multiple
            options={statusOptions}
            selected={statusFilter}
            onSelect={toggleStatus}
          />
          <FilterButton
            field="Lead"
            options={leadOptions}
            selected={leadFilter === '' ? [] : [leadFilter]}
            onSelect={(value) => {
              setParam('lead', value === leadFilter ? '' : value);
            }}
          />
          <FilterButton
            field="Team"
            options={teamOptions}
            selected={teamFilter === '' ? [] : [teamFilter]}
            onSelect={(value) => {
              const next = new URLSearchParams(params);
              writeParam(next, 'team', value === teamFilter ? '' : value);
              next.delete(ROLL_UP_PARAM);
              setParams(next, { replace: true });
            }}
          />
          {filteredTeam !== undefined && subTeams.length > 0 && (
            <SubTeamToggle rollUp={rollUp} onToggle={toggleRollUp} />
          )}
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(params);
                writeParam(next, 'team', '');
                writeParam(next, 'status', '');
                writeParam(next, 'lead', '');
                next.delete(ROLL_UP_PARAM);
                setParams(next, { replace: true });
              }}
            >
              <LuX aria-hidden="true" />
              Clear
            </Button>
          )}
          <div className="ml-auto flex items-center gap-1">
            <ProjectsDisplayMenu
              layout={layout}
              onLayoutChange={(value) => {
                changeDisplay({ layout: value });
              }}
              grouping={grouping}
              onGroupingChange={(value) => {
                changeDisplay({ group: value });
              }}
              ordering={ordering}
              onOrderingChange={(value) => {
                changeDisplay({ order: value });
              }}
              closed={closed}
              onClosedChange={(value) => {
                changeDisplay({ closed: value });
              }}
              onReset={reset}
            />
            {layout === 'timeline' && (
              <TimelineControls {...timelineControls} />
            )}
          </div>
          {saveBar}
        </div>
      }
    >
      {teamsError !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(
              teamsError,
              'Could not load teams. Try again shortly.'
            )}
          />
        </div>
      )}
      {error !== null && error !== undefined && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(
              error,
              'Could not load projects. Try again shortly.'
            )}
          />
        </div>
      )}
      {layout === 'list' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            role="presentation"
            className={cn(
              GRID,
              'sticky top-0 z-20 h-8 border-b border-line bg-bg px-4 text-2xs font-medium tracking-wide text-text-faint uppercase lg:px-6'
            )}
          >
            <span>Name</span>
            <span className="hidden px-2 md:block">Health</span>
            <span className="hidden text-center md:block">
              <span className="sr-only">Priority</span>
            </span>
            <span className="hidden px-2 md:block">Status</span>
            <span className="hidden text-center md:block">Lead</span>
            <span className="hidden px-2 md:block">Start</span>
            <span className="hidden px-2 md:block">Target</span>
            <span className="hidden md:block">Teams</span>
            <span className="text-right">
              <span className="hidden md:inline">Progress</span>
            </span>
          </div>
          {showSkeleton ? (
            <SkeletonRows label="Loading projects" />
          ) : rows.length === 0 && error == null && teamsError === null ? (
            <EmptyState
              icon={<LuTarget />}
              message={
                hasFilters
                  ? 'No projects match these filters.'
                  : 'No projects yet. A project is a dated body of work that one or more teams share.'
              }
            />
          ) : (
            groups.map((group, groupIndex) => {
              const open = isOpen(group);
              const start = starts[groupIndex] ?? 0;
              const status =
                group.kind === 'status'
                  ? (group.key.slice('status:'.length) as ProjectStatus)
                  : null;
              return (
                <section key={group.key} aria-label={group.label}>
                  {group.kind !== 'none' && (
                    <div className="group/header sticky top-8 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 transition-colors duration-100 hover:bg-raised lg:px-6">
                      <button
                        type="button"
                        aria-expanded={open}
                        data-hover="parent"
                        onClick={() => {
                          toggleFolded(group.key);
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                      >
                        <LuChevronRight
                          aria-hidden="true"
                          className={cn(
                            'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
                            open && 'rotate-90'
                          )}
                        />
                        <ProjectGroupGlyph group={group} teams={teams} />
                        <span className="truncate">{group.label}</span>
                        <span className="text-xs font-normal text-text-faint tabular-nums">
                          {String(group.rows.length)}
                        </span>
                      </button>
                      {canCreate && status !== null && (
                        <IconButton
                          label={`New ${PROJECT_STATUS_LABELS[status].toLowerCase()} project`}
                          size="sm"
                          className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                          onClick={() => {
                            setCreating(status);
                          }}
                        >
                          <LuPlus className="h-3.5 w-3.5" />
                        </IconButton>
                      )}
                    </div>
                  )}
                  {open && (
                    <ul>
                      {group.rows.map((project, index) => {
                        const position = start + index;
                        return (
                          <ProjectRow
                            key={project.project_id}
                            project={project}
                            slug={slug}
                            workspaceId={workspaceId}
                            teams={teams}
                            people={people}
                            byId={projectsById}
                            workspaceRole={workspace?.role}
                            isActive={position === activeIndex}
                            rowRef={registerItem(position)}
                            onPointerEnter={() => {
                              setActiveIndex(position);
                            }}
                            refreshKey={queryKey}
                          />
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })
          )}
        </div>
      ) : showSkeleton ? (
        <SkeletonRows label="Loading projects" />
      ) : layout === 'board' ? (
        <ProjectsBoard
          columns={columns}
          projects={rows}
          slug={slug}
          workspaceId={workspaceId}
          teams={teams}
          people={people}
          workspaceRole={workspace?.role}
          onMove={moveProject}
          createIn={(column) => {
            if (!canCreate || column.kind !== 'status') return undefined;
            const status = groupValue(column) as ProjectStatus;
            return () => {
              setCreating(status);
            };
          }}
        />
      ) : rows.length === 0 && error == null && teamsError === null ? (
        <EmptyState
          icon={<LuTarget />}
          message={
            hasFilters
              ? 'No projects match these filters.'
              : 'No projects yet. A project is a dated body of work that one or more teams share.'
          }
        />
      ) : (
        <ProjectTimeline
          ref={timeline}
          groups={groups}
          projects={sorted}
          slug={slug}
          workspaceId={workspaceId}
          teams={teams}
          people={people}
          workspaceRole={workspace?.role}
          zoom={zoom}
          folded={folded}
          onToggleGroup={toggleFolded}
          refreshKey={queryKey}
          listLabel="Projects on the timeline"
          testId="projects-timeline"
        />
      )}

      {creating !== null && (
        <CreateProjectDialog
          workspaceId={workspaceId}
          teams={writableTeams}
          initialTeamIds={initialTeamIds}
          initialStatus={creating}
          onClose={() => {
            setCreating(null);
          }}
          onCreated={(project) => {
            setCreating(null);
            invalidateQueries(queryKey);
            void navigate(projectPath(slug, project.project_id));
          }}
        />
      )}
      {saving === 'new' && (
        <SaveViewDialog
          open
          onClose={() => {
            setSaving(null);
          }}
          title={view === undefined ? 'Save view' : 'Save as new view'}
          teams={teams}
          initialTeamId={filteredTeam?.id}
          canShareWorkspace={workspace?.role !== 'guest'}
          initialName={view === undefined ? '' : `${view.name} copy`}
          {...(view === undefined
            ? {}
            : {
                initialLook: {
                  icon: view.icon ?? null,
                  color: view.color ?? null,
                  description: view.description ?? null,
                },
              })}
          onSave={saveNew}
        />
      )}
      {saving === 'details' && view !== undefined && (
        <SaveViewDialog
          open
          onClose={() => {
            setSaving(null);
          }}
          title="Edit view"
          teams={teams}
          detailsOnly
          {...viewVisibility(view, user?.id, workspace?.role)}
          submitLabel="Save changes"
          initialName={view.name}
          initialLook={{
            icon: view.icon ?? null,
            color: view.color ?? null,
            description: view.description ?? null,
          }}
          onSave={saveDetails}
        />
      )}
    </WorkspaceShell>
  );
};

export default Projects;
