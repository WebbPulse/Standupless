/**
 * Every project in the workspace, laid out as a dense list, a board or a
 * timeline. The list shows icon and name, then the properties the Display
 * menu keeps on: the summary, next milestone and dependency flags beside the
 * name, and columns for health, priority, status, lead, members, start and
 * target dates, teams, issues, created, updated and completed dates, and
 * progress. Hidden columns leave the grid, and health, priority, status, lead
 * and both dates edit from the row without opening it. The board puts
 * projects in columns by the grouping and moves them between columns by
 * dragging, and can drop columns that hold nothing; the timeline draws them
 * as bars from start to target date. Rows group by status, health, priority,
 * initiative, lead or team in either direction, the list can group again
 * inside each group, rows order by date, name, priority or progress, and
 * closed projects show for all time, a recent window or not at all. Filters
 * narrow by status, lead, team, and whether an open blocker holds a project
 * up or it holds another up, and on a team the page can keep only the
 * projects that team leads. Ctrl or Cmd and B flips between list and board.
 * The arrangement is saved to the account and carried in the URL so an
 * arranged page can be shared. Filtered to a parent team, the page
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
  LuBuilding2,
  LuChevronRight,
  LuDiamond,
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
import ProjectDependencyMarkers, {
  heldProjects,
  openBlockers,
} from '../../components/planning/ProjectDependencyMarkers';
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
import LoadError from '../../components/ui/load-error';
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
import { useCustomers } from '../../hooks/useCustomers';
import useCloseProjectPrompt from '../../hooks/useCloseProjectPrompt';
import { useInitiatives } from '../../hooks/useInitiatives';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useProjectMoves } from '../../hooks/useProjectMoves';
import { useProjectsDisplay } from '../../hooks/useProjectsDisplay';
import { useProjectsDisplayDefault } from '../../hooks/useProjectsDisplayDefault';
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
  INLINE_PROJECT_COLUMNS,
  PROJECTS_DISPLAY_FIELDS,
  PROJECT_COLUMN_LABELS,
  columnList,
  columnValue,
  directedGroups,
  effectiveRows,
  groupProjects,
  groupValue,
  sortProjects,
  withinClosedWindow,
  withinLeadTeams,
  type EmptyColumnsChoice,
  type LeadTeamChoice,
  type ProjectColumn,
  type ProjectGroup,
  type ProjectGrouping,
} from '../../lib/projectList';
import { shortDateLabel } from '../../lib/propertyOptions';
import {
  orderedStatuses,
  type FlagFilter,
  projectViewBase,
  sameProjectFilter,
  toProjectViewFilter,
} from '../../lib/projectView';
import { viewKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  ProjectMilestoneMarkerRead,
  ProjectRead,
  ProjectStatus,
  ProjectUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';
import { teamTree } from '../../lib/teamOrder';
import type { TimelineZoom } from '../../lib/timeline';

/** The grid every header and row lines up on, its tracks set by gridTracks. */
const GRID =
  'grid grid-cols-[var(--project-columns-narrow)] items-center gap-3 md:grid-cols-[var(--project-columns)]';

/** A property the list draws in a column of its own rather than beside the name. */
type GridColumn = Exclude<
  ProjectColumn,
  'summary' | 'milestones' | 'dependencies'
>;

/** The shown properties that take a grid column, in drawing order. */
const gridColumns = (shown: readonly ProjectColumn[]): GridColumn[] =>
  shown.filter(
    (column): column is GridColumn => !INLINE_PROJECT_COLUMNS.has(column)
  );

/** How wide each list column runs beside the name. */
const COLUMN_WIDTHS: Record<GridColumn, string> = {
  health: '7rem',
  priority: '2rem',
  status: '8.5rem',
  lead: '2rem',
  members: '4.5rem',
  start: '6rem',
  target: '6rem',
  teams: '6rem',
  issues: '4rem',
  created: '5.5rem',
  updated: '5.5rem',
  completed: '5.5rem',
  progress: '4.5rem',
};

/**
 * The grid tracks for the shown columns: every one beside the name on wide
 * screens, and only progress on narrow ones, so a hidden column leaves no gap.
 */
const gridTracks = (shown: readonly ProjectColumn[]): React.CSSProperties =>
  ({
    '--project-columns': [
      'minmax(0,1fr)',
      ...gridColumns(shown).map((column) => COLUMN_WIDTHS[column]),
    ].join(' '),
    '--project-columns-narrow': shown.includes('progress')
      ? 'minmax(0,1fr) 3.5rem'
      : 'minmax(0,1fr)',
  }) as React.CSSProperties;

/** The yes and no choices of the blocked and blocking filters. */
const FLAG_OPTIONS: ComboboxOption[] = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
];

/** Whether a project passes a yes or no filter, every project when it is unset. */
const flagMatches = (filter: string, holds: boolean): boolean =>
  filter === '' || (filter === 'true') === holds;

/** The statuses a closed project holds, hidden as board columns with completed projects. */
const CLOSED_STATUSES: ReadonlySet<ProjectStatus> = new Set([
  'completed',
  'canceled',
]);

/** The filter value that asks for projects with no lead. */
const NO_LEAD = 'none';

/** How each column's header cell sits over its column. */
const HEADER_CLASSES: Record<GridColumn, string> = {
  health: 'hidden px-2 md:block',
  priority: 'hidden text-center md:block',
  status: 'hidden px-2 md:block',
  lead: 'hidden text-center md:block',
  members: 'hidden md:block',
  start: 'hidden px-2 md:block',
  target: 'hidden px-2 md:block',
  teams: 'hidden md:block',
  issues: 'hidden text-right md:block',
  created: 'hidden md:block',
  updated: 'hidden md:block',
  completed: 'hidden md:block',
  progress: 'text-right',
};

/** The short header text of each column, where the header names it. */
const HEADER_LABELS: Record<GridColumn, string> = {
  ...PROJECT_COLUMN_LABELS,
  start: 'Start',
  target: 'Target',
};

/** How a stored timestamp reads in a date column, or a dash when there is none. */
const timestampLabel = (value: string | null | undefined): string =>
  value === null || value === undefined || value === ''
    ? '-'
    : shortDateLabel(value.slice(0, 10));

/** The project's next open milestone beside its name, or how many are done when all are. */
const NextMilestone: React.FC<{
  markers: ProjectMilestoneMarkerRead[] | undefined;
}> = ({ markers }) => {
  if (markers === undefined || markers.length === 0) return null;
  const next = markers.find((marker) => !marker.completed);
  const done = markers.filter((marker) => marker.completed).length;
  return (
    <span
      title={`${String(done)} of ${String(markers.length)} milestones done`}
      className="hidden max-w-40 min-w-0 shrink-0 items-center gap-1 text-xs text-text-muted lg:flex"
    >
      <LuDiamond aria-hidden="true" className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {next === undefined
          ? `${String(done)}/${String(markers.length)}`
          : next.name}
      </span>
    </span>
  );
};

/** Up to three member avatars, with a count of the rest. */
const MemberAvatars: React.FC<{
  memberIds: string[];
  people: Assignable[];
}> = ({ memberIds, people }) => {
  const members = memberIds
    .map((id) => people.find((person) => person.user_id === id))
    .filter((person): person is Assignable => person !== undefined);
  return (
    <span className="pointer-events-none hidden min-w-0 items-center md:flex">
      {members.slice(0, 3).map((person) => (
        <span key={person.user_id} className="-ml-1 first:ml-0">
          <Avatar
            name={personLabel(person)}
            src={personAvatar(person)}
            size="xs"
          />
        </span>
      ))}
      {members.length > 3 && (
        <span className="ml-1 text-2xs text-text-faint">
          +{String(members.length - 3)}
        </span>
      )}
      <span className="sr-only">
        {members.length === 0
          ? 'No members'
          : `Members ${members.map(personLabel).join(', ')}`}
      </span>
    </span>
  );
};

/** A blocked or blocking filter value, `true`, `false`, or empty when unset. */
const flagParam = (value: string): FlagFilter =>
  value === 'true' || value === 'false' ? value : '';
/** The customer filter value for projects no customer asked for. */
const NO_CUSTOMER = 'none';

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
  /** The columns shown beside the name, in drawing order. */
  shown: readonly ProjectColumn[];
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
  shown,
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
  const has = (column: ProjectColumn): boolean => shown.includes(column);

  return (
    <li
      ref={rowRef}
      onPointerEnter={onPointerEnter}
      style={gridTracks(shown)}
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
        {has('dependencies') && (
          <ProjectDependencyMarkers project={project} byId={byId} />
        )}
        <UpdateDueBadge project={project} className="shrink-0" />
        {has('milestones') && (
          <NextMilestone markers={project.milestone_markers} />
        )}
        {has('summary') &&
          project.description !== null &&
          project.description !== '' && (
            <span className="hidden min-w-0 truncate text-xs text-text-faint xl:block">
              {project.description.split('\n')[0]}
            </span>
          )}
      </div>
      {has('health') && (
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
      )}
      {has('priority') && (
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
      )}
      {has('status') && (
        <div className="relative z-10 hidden md:block">
          <ProjectStatusPicker
            variant="rail"
            value={project.status}
            percent={percent}
            disabled={!editable}
            onChange={closePrompt.changeStatus}
          />
        </div>
      )}
      {has('lead') && (
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
      )}
      {has('members') && (
        <MemberAvatars memberIds={project.member_ids} people={people} />
      )}
      {has('start') && (
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
      )}
      {has('target') && (
        <div className="relative z-10 hidden min-w-0 tabular-nums md:block">
          <DatePicker
            variant="rail"
            field="Target date"
            icon={null}
            emptyLabel="No date"
            value={project.target_date}
            disabled={!editable}
            {...(project.start_date === null
              ? {}
              : { min: project.start_date })}
            onChange={(target) => {
              void update({ target_date: target });
            }}
          />
        </div>
      )}
      {has('teams') && (
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
      )}
      {has('issues') && (
        <span className="pointer-events-none hidden justify-end text-xs text-text-muted tabular-nums md:flex">
          <span aria-hidden="true">{`${String(project.counts.done)}/${String(project.counts.total)}`}</span>
          <span className="sr-only">{`${String(project.counts.done)} of ${String(project.counts.total)} issues done`}</span>
        </span>
      )}
      {(['created', 'updated', 'completed'] as const).map(
        (column) =>
          has(column) && (
            <span
              key={column}
              className="pointer-events-none hidden truncate text-xs text-text-muted tabular-nums md:block"
            >
              <span className="sr-only">{`${PROJECT_COLUMN_LABELS[column]} `}</span>
              {timestampLabel(
                column === 'created'
                  ? project.created_at
                  : column === 'updated'
                    ? project.updated_at
                    : project.completed_at
              )}
            </span>
          )
      )}
      {has('progress') && (
        <span className="pointer-events-none flex items-center justify-end gap-1.5 text-xs text-text-muted tabular-nums">
          <ProgressRing percent={percent} />
          <span>{`${String(percent)}%`}</span>
        </span>
      )}
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
type FilterField =
  'team' | 'status' | 'lead' | 'blocked' | 'blocking' | 'customer';

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
            : field === 'lead'
              ? base.lead
              : base[field],
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
  const blockedFilter = flagParam(params.get('blocked') ?? baseOf('blocked'));
  const blockingFilter = flagParam(
    params.get('blocking') ?? baseOf('blocking')
  );
  const isMember = workspace !== null && workspace.role !== 'guest';
  const customerFilter = isMember
    ? (params.get('customer') ?? baseOf('customer'))
    : '';
  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);
  const { fallback: displayDefault, actionsFor: defaultActionsFor } =
    useProjectsDisplayDefault({
      workspaceId,
      workspaceRole: workspace?.role,
      team: filteredTeam,
      workspacePage: teamFilter === '',
      enabled: base === undefined,
    });
  const {
    display,
    change: changeDisplay,
    reset,
  } = useProjectsDisplay(base?.display, displayDefault);
  const {
    layout,
    group: grouping,
    direction,
    order: ordering,
    closed,
    zoom,
  } = display;
  const subGrouping =
    layout === 'list' ? effectiveRows(grouping, display.rows) : 'none';
  const shownColumns = useMemo(
    () => columnList(display.columns),
    [display.columns]
  );
  const baseRollUp = base?.rollUp ?? true;
  const {
    subTeams,
    rollUp,
    toggle: toggleRollUp,
  } = useSubTeamRollUp(filteredTeam, true, baseRollUp);
  const leadTeamIds = useMemo(
    () =>
      filteredTeam === undefined
        ? null
        : [filteredTeam.id, ...(rollUp ? subTeams.map((team) => team.id) : [])],
    [filteredTeam, rollUp, subTeams]
  );
  const heldRollUp = params.get(ROLL_UP_PARAM);
  const savedFilter = toProjectViewFilter({
    teamId:
      filteredTeam?.id ??
      (base !== undefined && teamFilter === base.team ? base.teamId : ''),
    status: statusFilter,
    lead: leadFilter,
    blocked: blockedFilter,
    blocking: blockingFilter,
    rollUp: heldRollUp === null ? baseRollUp : heldRollUp !== '0',
    customer: isMember ? customerFilter : (base?.customer ?? ''),
  });
  const changed =
    base !== undefined &&
    (!sameProjectFilter(savedFilter, toProjectViewFilter(base)) ||
      PROJECTS_DISPLAY_FIELDS.some(
        (field) => display[field] !== base.display[field]
      ));

  const customerOrdering = isMember && ordering === 'customers';
  const narrowing = useMemo(
    () => ({
      ...(customerFilter === '' ? {} : { customer_id: [customerFilter] }),
      ...(customerOrdering ? { sort: 'customer_requests_desc' as const } : {}),
    }),
    [customerFilter, customerOrdering]
  );
  const { projects, error, isLoading, queryKey, refetch } =
    useWorkspaceProjects(
      workspaceId,
      filteredTeam?.id ?? '',
      !isResolvingTeams && (teamFilter === '' || filteredTeam !== undefined),
      rollUp,
      narrowing
    );
  const { customers } = useCustomers(workspaceId, isMember);
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
    grouping === 'initiative' || subGrouping === 'initiative'
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
        .filter(
          (project) =>
            flagMatches(
              blockedFilter,
              openBlockers(project, projectsById).length > 0
            ) && flagMatches(blockingFilter, heldProjects(project).length > 0)
        )
        .filter((project) => withinClosedWindow(project, closed, now))
        .filter((project) =>
          withinLeadTeams(project, display.lead_team, leadTeamIds)
        ),
    [
      applyMoves,
      projects,
      projectsById,
      statusFilter,
      leadFilter,
      blockedFilter,
      blockingFilter,
      closed,
      now,
      display.lead_team,
      leadTeamIds,
    ]
  );

  const sorted = useMemo(() => sortProjects(rows, ordering), [rows, ordering]);
  const groups = useMemo(
    () =>
      directedGroups(
        groupProjects(sorted, grouping, people, teams, { initiatives }),
        direction
      ),
    [sorted, grouping, people, teams, initiatives, direction]
  );
  const columns = useMemo(
    () =>
      layout !== 'board'
        ? []
        : directedGroups(
            groupProjects(sorted, grouping, people, teams, {
              initiatives,
              keepEmpty: true,
            }),
            direction
          ).filter((column) => {
            if (display.empty === 'hide' && column.rows.length === 0)
              return false;
            if (column.kind !== 'status') return true;
            const status = groupValue(column) as ProjectStatus;
            if (statusFilter.length > 0) return statusFilter.includes(status);
            return closed !== 'none' || !CLOSED_STATUSES.has(status);
          }),
    [
      layout,
      sorted,
      grouping,
      people,
      teams,
      initiatives,
      direction,
      display.empty,
      statusFilter,
      closed,
    ]
  );
  const isOpen = useCallback(
    (group: ProjectGroup) =>
      group.kind === 'none' || !folded.includes(group.key),
    [folded]
  );
  const sections = useMemo(
    () =>
      groups.map((group) => ({
        group,
        subs:
          subGrouping === 'none'
            ? null
            : groupProjects(group.rows, subGrouping, people, teams, {
                initiatives,
              }).map((sub) => ({ sub, fold: `${group.key}/${sub.key}` })),
      })),
    [groups, subGrouping, people, teams, initiatives]
  );
  const { visible, starts } = useMemo(() => {
    const shown: ProjectRead[] = [];
    const at = new Map<string, number>();
    for (const { group, subs } of sections) {
      if (!isOpen(group)) continue;
      if (subs === null) {
        at.set(group.key, shown.length);
        shown.push(...group.rows);
        continue;
      }
      for (const { sub, fold } of subs) {
        if (folded.includes(fold)) continue;
        at.set(fold, shown.length);
        shown.push(...sub.rows);
      }
    }
    return { visible: shown, starts: at };
  }, [sections, isOpen, folded]);

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
    teamFilter !== '' ||
    statusFilter.length > 0 ||
    leadFilter !== '' ||
    blockedFilter !== '' ||
    blockingFilter !== '' ||
    customerFilter !== '';

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
    keys: 'mod+b',
    label: 'Toggle list and board',
    group: 'Projects',
    handler: (event) => {
      event?.preventDefault();
      changeDisplay({ layout: layout === 'board' ? 'list' : 'board' });
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
  const customerOptions: ComboboxOption[] = [
    { value: NO_CUSTOMER, label: 'No customer' },
    ...customers.map((customer) => ({
      value: customer.customer_id,
      label: customer.name,
      icon: <LuBuilding2 className="h-3.5 w-3.5 text-text-muted" />,
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
          {isMember && (
            <FilterButton
              field="Customer"
              options={customerOptions}
              selected={customerFilter === '' ? [] : [customerFilter]}
              onSelect={(value) => {
                setParam('customer', value === customerFilter ? '' : value);
              }}
            />
          )}
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
          <FilterButton
            field="Blocked"
            options={FLAG_OPTIONS}
            selected={blockedFilter === '' ? [] : [blockedFilter]}
            onSelect={(value) => {
              setParam('blocked', value === blockedFilter ? '' : value);
            }}
          />
          <FilterButton
            field="Blocking"
            options={FLAG_OPTIONS}
            selected={blockingFilter === '' ? [] : [blockingFilter]}
            onSelect={(value) => {
              setParam('blocking', value === blockingFilter ? '' : value);
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
                writeParam(next, 'blocked', '');
                writeParam(next, 'blocking', '');
                writeParam(next, 'customer', '');
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
              direction={direction}
              onDirectionChange={(value) => {
                changeDisplay({ direction: value });
              }}
              {...(layout === 'list'
                ? {
                    rows: display.rows,
                    onRowsChange: (value: ProjectGrouping) => {
                      changeDisplay({ rows: value });
                    },
                  }
                : {})}
              ordering={ordering}
              onOrderingChange={(value) => {
                changeDisplay({ order: value });
              }}
              closed={closed}
              onClosedChange={(value) => {
                changeDisplay({ closed: value });
              }}
              {...(filteredTeam === undefined
                ? {}
                : {
                    leadTeam: display.lead_team,
                    onLeadTeamChange: (value: LeadTeamChoice) => {
                      changeDisplay({ lead_team: value });
                    },
                  })}
              {...(layout === 'board'
                ? {
                    empty: display.empty,
                    onEmptyChange: (value: EmptyColumnsChoice) => {
                      changeDisplay({ empty: value });
                    },
                  }
                : {})}
              {...(layout !== 'timeline'
                ? {
                    columns: shownColumns,
                    onColumnsChange: (value: ProjectColumn[]) => {
                      changeDisplay({ columns: columnValue(value) });
                    },
                  }
                : {})}
              onReset={reset}
              defaultActions={defaultActionsFor(display)}
              customerOrdering={isMember}
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
          <LoadError
            message={errorMessage(
              error,
              'Could not load projects. Try again shortly.'
            )}
            onRetry={refetch}
          />
        </div>
      )}
      {layout === 'list' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            role="presentation"
            style={gridTracks(shownColumns)}
            className={cn(
              GRID,
              'sticky top-0 z-20 h-8 border-b border-line bg-bg px-4 text-2xs font-medium tracking-wide text-text-faint uppercase lg:px-6'
            )}
          >
            <span>Name</span>
            {gridColumns(shownColumns).map((column) => (
              <span key={column} className={HEADER_CLASSES[column]}>
                {column === 'priority' ? (
                  <span className="sr-only">
                    {PROJECT_COLUMN_LABELS.priority}
                  </span>
                ) : column === 'progress' ? (
                  <span className="hidden md:inline">
                    {PROJECT_COLUMN_LABELS.progress}
                  </span>
                ) : (
                  HEADER_LABELS[column]
                )}
              </span>
            ))}
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
            sections.map(({ group, subs }) => {
              const open = isOpen(group);
              const status =
                group.kind === 'status'
                  ? (group.key.slice('status:'.length) as ProjectStatus)
                  : null;
              const list = (
                items: ProjectRead[],
                start: number
              ): React.ReactElement => (
                <ul>
                  {items.map((project, index) => {
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
                        shown={shownColumns}
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
              );
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
                  {open &&
                    (subs === null
                      ? list(group.rows, starts.get(group.key) ?? 0)
                      : subs.map(({ sub, fold }) => {
                          const subOpen = !folded.includes(fold);
                          return (
                            <section
                              key={fold}
                              aria-label={`${group.label}, ${sub.label}`}
                            >
                              <button
                                type="button"
                                aria-expanded={subOpen}
                                onClick={() => {
                                  toggleFolded(fold);
                                }}
                                className="flex h-8 w-full min-w-0 items-center gap-2 border-b border-line bg-bg pr-4 pl-8 text-left text-xs font-medium text-text-muted transition-colors duration-100 hover:bg-surface focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset lg:pr-6 lg:pl-10"
                              >
                                <LuChevronRight
                                  aria-hidden="true"
                                  className={cn(
                                    'h-3 w-3 text-text-faint transition-transform duration-100',
                                    subOpen && 'rotate-90'
                                  )}
                                />
                                <ProjectGroupGlyph group={sub} teams={teams} />
                                <span className="truncate">{sub.label}</span>
                                <span className="font-normal text-text-faint tabular-nums">
                                  {String(sub.rows.length)}
                                </span>
                              </button>
                              {subOpen && list(sub.rows, starts.get(fold) ?? 0)}
                            </section>
                          );
                        }))}
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
          shown={shownColumns}
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
