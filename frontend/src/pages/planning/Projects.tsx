/**
 * Every project in the workspace as one dense table: icon and name, health,
 * priority, status, lead, target date, teams and progress. Rows group by status, lead or team
 * and order by date, name or progress from the Display menu; the filters,
 * grouping and ordering live in the URL so an arranged list can be shared,
 * and health, priority, status and lead can be changed from the row without
 * opening it.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuListFilter,
  LuPlus,
  LuTarget,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { updateProject } from '../../api/planning';
import CreateProjectDialog from '../../components/planning/CreateProjectDialog';
import ProgressRing from '../../components/planning/ProgressRing';
import { PriorityPicker } from '../../components/issues/PropertyPickers';
import {
  HealthPicker,
  LeadPicker,
  ProjectStatusPicker,
  TeamKey,
} from '../../components/planning/ProjectPickers';
import ProjectGroupGlyph from '../../components/planning/ProjectGroupGlyph';
import UpdateDueBadge from '../../components/planning/UpdateDueBadge';
import ProjectIcon from '../../components/planning/ProjectIcon';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import ProjectsDisplayMenu from '../../components/planning/ProjectsDisplayMenu';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button, { IconButton } from '../../components/ui/button';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox';
import EmptyState from '../../components/ui/empty-state';
import { Popover } from '../../components/ui/popover';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { usePlanningTeamLists } from '../../hooks/usePlanningTeamLists';
import { useShortcut } from '../../hooks/useShortcuts';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  completionPercent,
} from '../../lib/planningDisplay';
import { PROJECT_STATUS_ORDER, canEditProject } from '../../lib/planningModel';
import {
  groupProjects,
  parseGrouping,
  parseOrdering,
  sortProjects,
  type ProjectGroup,
} from '../../lib/projectList';
import { shortDateLabel } from '../../lib/propertyOptions';
import type {
  ProjectRead,
  ProjectStatus,
  ProjectUpdate,
  TeamRead,
  WorkspaceRole,
} from '../../types/Api';

/** The grid every header and row lines up on. */
const GRID =
  'grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_7rem_2rem_8.5rem_2rem_6rem_6rem_4.5rem]';

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
  workspaceRole: WorkspaceRole | undefined;
  isActive: boolean;
  rowRef: (node: HTMLElement | null) => void;
  onPointerEnter: () => void;
  refreshKey: ReturnType<typeof useWorkspaceProjects>['queryKey'];
}

/**
 * One project as a table row. The whole row opens the project; the health,
 * priority, status and lead cells sit above that link and edit in place,
 * optimistically.
 */
const ProjectRow: React.FC<ProjectRowProps> = ({
  project: server,
  slug,
  workspaceId,
  teams,
  people,
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
  const percent = completionPercent(project.counts);
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
          onChange={(status) => {
            void update({ status });
          }}
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
      <span
        className={cn(
          'hidden text-xs whitespace-nowrap tabular-nums md:block',
          project.target_date === null ? 'text-text-faint' : 'text-text-muted'
        )}
      >
        {project.target_date === null
          ? 'No date'
          : shortDateLabel(project.target_date)}
      </span>
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
    </li>
  );
};

/** The projects of the whole workspace, grouped, filtered and editable. */
export const Projects: React.FC = () => {
  const { workspace } = useWorkspace();
  const slug = workspace?.slug ?? '';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const {
    teams,
    workspaceId,
    isLoading: isResolvingTeams,
    error: teamsError,
  } = useTeam(undefined);

  const teamFilter = params.get('team') ?? '';
  const statusFilter = useMemo(
    () =>
      (params.get('status') ?? '')
        .split(',')
        .filter((value): value is ProjectStatus =>
          PROJECT_STATUS_ORDER.includes(value as ProjectStatus)
        ),
    [params]
  );
  const leadFilter = params.get('lead') ?? '';
  const grouping = parseGrouping(params.get('group'));
  const ordering = parseOrdering(params.get('order'));
  const filteredTeam = teams.find((team) => team.key_prefix === teamFilter);

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

  const [creating, setCreating] = useState<ProjectStatus | null>(null);
  const [folded, setFolded] = useState<string[]>([]);

  const writableTeams = useMemo(
    () => teams.filter((team) => canWriteIssues(workspace?.role, team.role)),
    [teams, workspace?.role]
  );
  const canCreate = writableTeams.length > 0;

  const rows = useMemo(
    () =>
      projects
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
        ),
    [projects, statusFilter, leadFilter]
  );

  const groups = useMemo(
    () => groupProjects(sortProjects(rows, ordering), grouping, people, teams),
    [rows, ordering, grouping, people, teams]
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
    enabled: creating === null,
  });

  const setParam = (field: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(field);
    else next.set(field, value);
    setParams(next, { replace: true });
  };

  const toggleStatus = (status: string): void => {
    const held = statusFilter as string[];
    setParam(
      'status',
      (held.includes(status)
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
    keys: 'shift+g',
    label: 'Toggle grouping',
    group: 'Projects',
    handler: () => {
      setParam('group', grouping === 'none' ? '' : 'none');
    },
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
  const teamOptions: ComboboxOption[] = teams.map((team) => ({
    value: team.key_prefix,
    label: team.name,
    icon: <TeamKey keyPrefix={team.key_prefix} />,
  }));

  const initialTeamIds =
    filteredTeam !== undefined && writableTeams.includes(filteredTeam)
      ? [filteredTeam.id]
      : writableTeams[0] === undefined
        ? []
        : [writableTeams[0].id];

  const showSkeleton =
    teamsError === null && (isResolvingTeams || isLoading) && rows.length === 0;

  return (
    <WorkspaceShell
      title="Projects"
      flush
      actions={
        canCreate ? (
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
        ) : undefined
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
              setParam('team', value === teamFilter ? '' : value);
            }}
          />
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('team');
                next.delete('status');
                next.delete('lead');
                setParams(next, { replace: true });
              }}
            >
              <LuX aria-hidden="true" />
              Clear
            </Button>
          )}
          <div className="ml-auto">
            <ProjectsDisplayMenu
              grouping={grouping}
              ordering={ordering}
              onGroupingChange={(value) => {
                setParam('group', value === 'status' ? '' : value);
              }}
              onOrderingChange={(value) => {
                setParam('order', value === 'target' ? '' : value);
              }}
              onReset={
                grouping === 'status' && ordering === 'target'
                  ? undefined
                  : () => {
                      const next = new URLSearchParams(params);
                      next.delete('group');
                      next.delete('order');
                      setParams(next, { replace: true });
                    }
              }
            />
          </div>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
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
          <span className="hidden md:block">Target</span>
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
                        setFolded((held) =>
                          held.includes(group.key)
                            ? held.filter((value) => value !== group.key)
                            : [...held, group.key]
                        );
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
    </WorkspaceShell>
  );
};

export default Projects;
