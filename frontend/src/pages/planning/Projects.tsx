/**
 * Every project in the workspace as one dense table: name, status, lead,
 * target date, teams and progress, grouped by status the way a planning
 * review reads them. Status, lead and team filters live in the URL so a
 * filtered list can be shared, and status and lead can be changed from the
 * row without opening the project.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuListFilter,
  LuPlus,
  LuRows3,
  LuTarget,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { updateProject } from '../../api/planning';
import CreateProjectDialog from '../../components/planning/CreateProjectDialog';
import ProgressRing from '../../components/planning/ProgressRing';
import {
  LeadPicker,
  ProjectStatusPicker,
  TeamKey,
} from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
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
import { personLabel, type Assignable } from '../../lib/issuePeople';
import { useOptimisticRecord } from '../../lib/optimistic';
import { projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  completionPercent,
} from '../../lib/planningDisplay';
import {
  PROJECT_STATUS_ORDER,
  canEditProject,
  groupProjectsByStatus,
} from '../../lib/planningModel';
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
  'grid grid-cols-[minmax(0,1fr)_7.5rem_2rem] items-center gap-3 md:grid-cols-[minmax(0,1fr)_9rem_8rem_6.5rem_7rem_5rem]';

/** The filter value that asks for projects with no lead. */
const NO_LEAD = 'none';

/** Orders projects by target date, undated last, then by name. */
const byTargetDate = (left: ProjectRead, right: ProjectRead): number => {
  const a = left.target_date;
  const b = right.target_date;
  if (a !== b) {
    if (a === null) return 1;
    if (b === null) return -1;
    return a.localeCompare(b);
  }
  return left.name.localeCompare(right.name);
};

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
 * One project as a table row. The whole row opens the project; the status
 * and lead cells sit above that link and edit in place, optimistically.
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
        'relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface lg:px-6',
        isActive && 'bg-surface'
      )}
    >
      <Link
        to={href}
        aria-label={project.name}
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5">
        <ProjectStatusGlyph status={project.status} percent={percent} />
        <span className="truncate font-medium text-text">{project.name}</span>
        {project.description !== null && project.description !== '' && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint xl:block">
            {project.description.split('\n')[0]}
          </span>
        )}
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
      <div className="relative z-10 hidden min-w-0 md:block">
        {editable ? (
          <LeadPicker
            variant="rail"
            value={project.lead_id}
            people={people}
            onChange={(leadId) => {
              void update({ lead_id: leadId });
            }}
          />
        ) : (
          <span className="flex items-center gap-2 px-2 text-sm text-text-muted">
            {lead === undefined ? 'No lead' : personLabel(lead)}
          </span>
        )}
      </div>
      <span
        className={cn(
          'text-xs whitespace-nowrap tabular-nums',
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
        <span className="hidden md:inline">{`${String(percent)}%`}</span>
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
  const grouped = params.get('group') !== 'none';
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
  const [folded, setFolded] = useState<ProjectStatus[]>([]);

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
        )
        .sort(byTargetDate),
    [projects, statusFilter, leadFilter]
  );

  const groups = useMemo(
    () =>
      grouped
        ? groupProjectsByStatus(rows)
        : [{ key: null as ProjectStatus | null, rows }],
    [grouped, rows]
  );
  const visible = useMemo(
    () =>
      groups
        .filter((group) => group.key === null || !folded.includes(group.key))
        .flatMap((group) => group.rows),
    [groups, folded]
  );
  const starts = useMemo(
    () =>
      groups.map((_, index) =>
        groups
          .slice(0, index)
          .filter((group) => group.key === null || !folded.includes(group.key))
          .reduce((sum, group) => sum + group.rows.length, 0)
      ),
    [groups, folded]
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
      setParam('group', grouped ? 'none' : '');
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
      icon: <Avatar name={personLabel(person)} size="xs" />,
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
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={grouped}
              onClick={() => {
                setParam('group', grouped ? 'none' : '');
              }}
            >
              <LuRows3 aria-hidden="true" />
              {grouped ? 'Grouped by status' : 'No grouping'}
            </Button>
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
          <span className="hidden px-2 md:block">Status</span>
          <span className="hidden px-2 md:block">Lead</span>
          <span>Target</span>
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
            const key = group.key;
            const isOpen = key === null || !folded.includes(key);
            const start = starts[groupIndex] ?? 0;
            return (
              <section
                key={key ?? 'all'}
                aria-label={
                  key === null ? 'Projects' : PROJECT_STATUS_LABELS[key]
                }
              >
                {key !== null && (
                  <div className="group/header sticky top-8 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 lg:px-6">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => {
                        setFolded((held) =>
                          held.includes(key)
                            ? held.filter((value) => value !== key)
                            : [...held, key]
                        );
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                    >
                      <LuChevronRight
                        aria-hidden="true"
                        className={cn(
                          'h-3.5 w-3.5 text-text-faint transition-transform duration-100',
                          isOpen && 'rotate-90'
                        )}
                      />
                      <ProjectStatusGlyph status={key} />
                      {PROJECT_STATUS_LABELS[key]}
                      <span className="text-xs font-normal text-text-faint tabular-nums">
                        {String(group.rows.length)}
                      </span>
                    </button>
                    {canCreate && (
                      <IconButton
                        label={`New ${PROJECT_STATUS_LABELS[key].toLowerCase()} project`}
                        size="sm"
                        className="opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
                        onClick={() => {
                          setCreating(key);
                        }}
                      >
                        <LuPlus className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  </div>
                )}
                {isOpen && (
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
