/**
 * Every initiative in the workspace, grouped by status or by lead team. An
 * initiative groups projects across teams, so each row can show its health,
 * lead team, owner, how many projects it holds, its target date and how far
 * those projects have come. Sub-initiatives sit indented under their parent,
 * and a parent folds away. Filters for status, team, owner and health sit in
 * the toolbar, and the Display menu picks the grouping, the ordering, whether
 * completed initiatives show and which properties show; all of it is kept in the URL so an arranged page can be
 * shared, and the arrangement follows the person's account.
 */

import React, { useMemo, useState } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import {
  LuChevronDown,
  LuChevronRight,
  LuGoal,
  LuListFilter,
  LuPlus,
  LuUsers,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import CreateInitiativeDialog from '../../components/planning/CreateInitiativeDialog';
import InitiativesDisplayMenu from '../../components/planning/InitiativesDisplayMenu';
import ProgressRing from '../../components/planning/ProgressRing';
import ProjectHealthGlyph from '../../components/planning/ProjectHealthGlyph';
import { TeamKey } from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Button from '../../components/ui/button';
import type { ComboboxOption } from '../../components/ui/combobox';
import EmptyState from '../../components/ui/empty-state';
import FilterButton from '../../components/ui/filter-button';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import { useInitiatives } from '../../hooks/useInitiatives';
import { useInitiativesDisplay } from '../../hooks/useInitiativesDisplay';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { canWriteIssues } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import {
  INITIATIVE_COLUMN_LABELS,
  NO_HEALTH,
  NO_OWNER,
  NO_TEAM,
  initiativeColumnList,
  initiativeColumnValue,
  isHealthFilterValue,
  matchesInitiativeFilters,
  orderInitiatives,
  type InitiativeColumn,
} from '../../lib/initiativeList';
import {
  initiativeTreeRows,
  type InitiativeTreeRow,
} from '../../lib/initiativeTree';
import {
  personAvatar,
  personLabel,
  type Assignable,
} from '../../lib/issuePeople';
import { initiativePath } from '../../lib/paths';
import {
  INITIATIVE_STATUSES,
  INITIATIVE_STATUS_GLYPHS,
  INITIATIVE_STATUS_LABELS,
  progressPercent,
} from '../../lib/planningDisplay';
import { PROJECT_HEALTHS, PROJECT_HEALTH_LABELS } from '../../lib/projectLook';
import { planningDateLabel } from '../../lib/dateResolution';
import { teamTree } from '../../lib/teamOrder';
import type {
  InitiativeRead,
  InitiativeStatus,
  TeamRead,
} from '../../types/Api';

/** The grid every header and row lines up on, its tracks set by the shown properties. */
const GRID =
  'grid grid-cols-[var(--initiative-cols-sm)] items-center gap-3 md:grid-cols-[var(--initiative-cols)]';

/** The track each property takes on a wide screen. */
const COLUMN_TRACKS: Record<InitiativeColumn, string> = {
  health: '4rem',
  team: '4.5rem',
  owner: '3.5rem',
  projects: '5.5rem',
  target: '6rem',
  progress: '4.5rem',
};

/** The grid tracks for the shown properties, as CSS variables the grid reads. */
const gridStyle = (shown: readonly InitiativeColumn[]): React.CSSProperties =>
  ({
    '--initiative-cols': [
      'minmax(0,1fr)',
      ...shown.map((column) => COLUMN_TRACKS[column]),
    ].join(' '),
    '--initiative-cols-sm': shown.includes('progress')
      ? 'minmax(0,1fr) 3.5rem'
      : 'minmax(0,1fr)',
  }) as React.CSSProperties;

/** How far each level of sub-initiative is indented, in rem. */
const INDENT_REM = 1.25;

/** Props for InitiativeRow: its place in the tree and the people its owner is among. */
interface InitiativeRowProps {
  row: InitiativeTreeRow;
  slug: string;
  people: Assignable[];
  /** The teams a lead team is named from. */
  teams: readonly TeamRead[];
  /** The properties shown beside the name, in drawing order. */
  shown: readonly InitiativeColumn[];
  collapsed: boolean;
  onToggle: (initiativeId: string) => void;
}

/** One initiative as a row linking to its page, indented under its parent. */
const InitiativeRow: React.FC<InitiativeRowProps> = ({
  row,
  slug,
  people,
  teams,
  shown,
  collapsed,
  onToggle,
}) => {
  const { initiative, depth, childCount, parentName } = row;
  const percent = progressPercent(initiative);
  const owner = people.find((person) => person.user_id === initiative.owner_id);
  const team = teams.find((item) => item.id === initiative.team_id);
  const projects = initiative.project_count;
  return (
    <li
      style={gridStyle(shown)}
      className={cn(
        GRID,
        'relative h-11 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface has-[a:active]:bg-raised lg:px-6'
      )}
    >
      <Link
        to={initiativePath(slug, initiative.initiative_id)}
        aria-label={initiative.name}
        data-hover="parent"
        className="absolute inset-0 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none focus-visible:ring-inset"
      />
      <div
        className="pointer-events-none flex min-w-0 items-center gap-2.5"
        style={{ paddingLeft: `${String(depth * INDENT_REM)}rem` }}
      >
        {childCount > 0 ? (
          <button
            type="button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${initiative.name}`}
            aria-expanded={!collapsed}
            onClick={() => {
              onToggle(initiative.initiative_id);
            }}
            className="pointer-events-auto relative z-10 -mx-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {collapsed ? (
              <LuChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          depth > 0 && (
            <span aria-hidden="true" className="-mx-1 w-5 shrink-0" />
          )
        )}
        <LuGoal
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-text-muted"
        />
        <span className="truncate font-medium text-text">
          {initiative.name}
        </span>
        {collapsed && childCount > 0 && (
          <span className="shrink-0 text-xs text-text-faint tabular-nums">
            {`${String(childCount)} sub-${childCount === 1 ? 'initiative' : 'initiatives'}`}
          </span>
        )}
        {parentName !== null && (
          <span className="hidden shrink-0 truncate text-xs text-text-faint sm:inline">
            {`in ${parentName}`}
          </span>
        )}
        {initiative.description !== null && initiative.description !== '' && (
          <span className="hidden min-w-0 truncate text-xs text-text-faint xl:block">
            {initiative.description.split('\n')[0]}
          </span>
        )}
      </div>
      {shown.includes('health') && (
        <span className="pointer-events-none hidden justify-center md:flex">
          <ProjectHealthGlyph
            health={initiative.health}
            name={`Health ${initiative.health === null ? 'not set' : initiative.health.replace('_', ' ')}`}
          />
        </span>
      )}
      {shown.includes('team') && (
        <span className="pointer-events-none hidden min-w-0 items-center gap-1.5 text-xs text-text-muted md:flex">
          {team === undefined ? (
            <span className="sr-only">No team</span>
          ) : (
            <>
              <TeamKey keyPrefix={team.key_prefix} />
              <span className="sr-only">{`Team ${team.name}`}</span>
            </>
          )}
        </span>
      )}
      {shown.includes('owner') && (
        <span className="pointer-events-none hidden justify-center md:flex">
          {owner === undefined ? (
            <span className="sr-only">No owner</span>
          ) : (
            <>
              <Avatar
                name={personLabel(owner)}
                src={personAvatar(owner)}
                size="xs"
              />
              <span className="sr-only">{`Owner ${personLabel(owner)}`}</span>
            </>
          )}
        </span>
      )}
      {shown.includes('projects') && (
        <span className="pointer-events-none hidden text-xs whitespace-nowrap text-text-muted tabular-nums md:block">
          {`${String(projects)} ${projects === 1 ? 'project' : 'projects'}`}
        </span>
      )}
      {shown.includes('target') && (
        <span
          className={cn(
            'pointer-events-none hidden text-xs whitespace-nowrap tabular-nums md:block',
            initiative.target_date === null
              ? 'text-text-faint'
              : 'text-text-muted'
          )}
        >
          {initiative.target_date === null
            ? 'No date'
            : planningDateLabel(
                initiative.target_date,
                initiative.target_date_resolution
              )}
        </span>
      )}
      {shown.includes('progress') && (
        <span className="pointer-events-none flex items-center justify-end gap-1.5 text-xs text-text-muted tabular-nums">
          <ProgressRing percent={percent} />
          <span>{`${String(percent)}%`}</span>
        </span>
      )}
    </li>
  );
};

/** The filters the page keeps in the URL. */
type FilterField = 'status' | 'owner' | 'health' | 'team';

/** One group of the list: a status or a lead team, with its rows. */
interface InitiativeGroup {
  key: string;
  label: string;
  icon: React.ReactNode;
  rows: InitiativeRead[];
}

/** Splits the ordered rows into status groups, keeping completed only when asked. */
const statusGroups = (
  ordered: readonly InitiativeRead[],
  showsCompleted: boolean
): InitiativeGroup[] =>
  INITIATIVE_STATUSES.filter(
    (status) => status !== 'completed' || showsCompleted
  ).map((status) => ({
    key: status,
    label: INITIATIVE_STATUS_LABELS[status],
    icon: <ProjectStatusGlyph status={INITIATIVE_STATUS_GLYPHS[status]} />,
    rows: ordered.filter((initiative) => initiative.status === status),
  }));

/** Splits the ordered rows into one group per lead team in sidebar order, then No team. */
const teamGroups = (
  ordered: readonly InitiativeRead[],
  teams: readonly TeamRead[]
): InitiativeGroup[] => [
  ...teamTree([...teams]).map(({ team }) => ({
    key: team.id,
    label: team.name,
    icon: <TeamKey keyPrefix={team.key_prefix} />,
    rows: ordered.filter((initiative) => initiative.team_id === team.id),
  })),
  {
    key: NO_TEAM,
    label: 'No team',
    icon: (
      <LuUsers aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
    ),
    rows: ordered.filter(
      (initiative) =>
        initiative.team_id == null ||
        !teams.some((team) => team.id === initiative.team_id)
    ),
  },
];

/** The workspace's initiatives, grouped by status, filtered, arranged, with a way to start one. */
export const Initiatives: React.FC = () => {
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const navigate = useNavigate();
  const slug = workspace?.slug ?? '';
  const workspaceId = workspace?.id ?? '';
  const isMember = workspace !== null && workspace.role !== 'guest';
  const { initiatives, error, isLoading, queryKey } = useInitiatives(
    workspaceId,
    isMember
  );
  const members = useWorkspaceMembers(workspaceId, isMember);
  const { data: teamList } = useTeams();
  const teams = useMemo(() => teamList ?? [], [teamList]);
  const [isCreating, setIsCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [params, setParams] = useSearchParams();
  const { display, change: changeDisplay, reset } = useInitiativesDisplay();
  const shown = useMemo(
    () => initiativeColumnList(display.columns),
    [display.columns]
  );

  const statusText = params.get('status') ?? '';
  const statusFilter = useMemo(
    () =>
      INITIATIVE_STATUSES.filter((status) =>
        statusText.split(',').includes(status)
      ),
    [statusText]
  );
  const ownerFilter = params.get('owner') ?? '';
  const healthText = params.get('health') ?? '';
  const healthFilter = useMemo(
    () => healthText.split(',').filter(isHealthFilterValue),
    [healthText]
  );
  const teamParam = params.get('team') ?? '';
  const filteredTeam = teams.find((team) => team.key_prefix === teamParam);
  const teamFilter =
    teamParam === '' || teamParam === NO_TEAM
      ? teamParam
      : (filteredTeam?.id ?? teamParam);
  const hasFilters =
    statusFilter.length > 0 ||
    ownerFilter !== '' ||
    healthFilter.length > 0 ||
    teamFilter !== '';
  const writableTeams = useMemo(
    () =>
      teams.filter(
        (team) =>
          (team.retired_at ?? null) === null &&
          canWriteIssues(workspace?.role, team.role)
      ),
    [teams, workspace?.role]
  );

  const setParam = (field: FilterField, value: string): void => {
    const next = new URLSearchParams(params);
    if (value === '') next.delete(field);
    else next.set(field, value);
    setParams(next, { replace: true });
  };

  const toggleIn = <T extends string>(
    held: readonly T[],
    value: T,
    order: readonly T[]
  ): string => {
    const next = held.includes(value)
      ? held.filter((item) => item !== value)
      : [...held, value];
    return order.filter((item) => next.includes(item)).join(',');
  };

  const toggle = (initiativeId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(initiativeId)) next.delete(initiativeId);
      else next.add(initiativeId);
      return next;
    });
  };

  const groups = useMemo(() => {
    const filters = {
      status: statusFilter,
      owner: ownerFilter,
      health: healthFilter,
      team: teamFilter,
    };
    const showsCompleted =
      display.completed === 'show' || statusFilter.includes('completed');
    const ordered = orderInitiatives(
      initiatives.filter(
        (initiative) =>
          matchesInitiativeFilters(initiative, filters) &&
          (showsCompleted || initiative.status !== 'completed')
      ),
      display.order
    );
    const grouped =
      display.grouping === 'team'
        ? teamGroups(ordered, teams)
        : statusGroups(ordered, showsCompleted);
    return grouped
      .map((group) => ({
        ...group,
        count: group.rows.length,
        tree: initiativeTreeRows(group.rows, initiatives, collapsed),
      }))
      .filter((group) => group.count > 0);
  }, [
    initiatives,
    teams,
    collapsed,
    statusFilter,
    ownerFilter,
    healthFilter,
    teamFilter,
    display.completed,
    display.order,
    display.grouping,
  ]);

  const statusOptions: ComboboxOption[] = INITIATIVE_STATUSES.map((status) => ({
    value: status,
    label: INITIATIVE_STATUS_LABELS[status],
    icon: <ProjectStatusGlyph status={INITIATIVE_STATUS_GLYPHS[status]} />,
  }));
  const ownerOptions: ComboboxOption[] = [
    { value: NO_OWNER, label: 'No owner' },
    ...members.map((person) => ({
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
  const healthOptions: ComboboxOption[] = [
    ...PROJECT_HEALTHS.map((health) => ({
      value: health,
      label: PROJECT_HEALTH_LABELS[health],
      icon: <ProjectHealthGlyph health={health} />,
    })),
    {
      value: NO_HEALTH,
      label: 'No health',
      icon: <ProjectHealthGlyph health={null} />,
    },
  ];
  const healthOrder = [...PROJECT_HEALTHS, NO_HEALTH] as const;
  const teamOptions: ComboboxOption[] = [
    ...teamTree(teams).map(({ team, nested, parentName }) => ({
      value: team.key_prefix,
      label: team.name,
      icon: <TeamKey keyPrefix={team.key_prefix} />,
      indent: nested,
      ...(parentName === undefined ? {} : { keywords: [parentName] }),
    })),
    {
      value: NO_TEAM,
      label: 'No team',
      icon: <LuUsers className="h-3.5 w-3.5 text-text-muted" />,
    },
  ];

  return (
    <WorkspaceShell
      title="Initiatives"
      flush
      actions={
        isMember ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setIsCreating(true);
            }}
          >
            <LuPlus aria-hidden="true" />
            New initiative
          </Button>
        ) : undefined
      }
      toolbar={
        isMember ? (
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
              onSelect={(value) => {
                const status = INITIATIVE_STATUSES.find(
                  (item) => item === value
                );
                if (status === undefined) return;
                setParam(
                  'status',
                  toggleIn<InitiativeStatus>(
                    statusFilter,
                    status,
                    INITIATIVE_STATUSES
                  )
                );
              }}
            />
            <FilterButton
              field="Team"
              options={teamOptions}
              selected={teamParam === '' ? [] : [teamParam]}
              onSelect={(value) => {
                setParam('team', value === teamParam ? '' : value);
              }}
            />
            <FilterButton
              field="Owner"
              options={ownerOptions}
              selected={ownerFilter === '' ? [] : [ownerFilter]}
              onSelect={(value) => {
                setParam('owner', value === ownerFilter ? '' : value);
              }}
            />
            <FilterButton
              field="Health"
              multiple
              options={healthOptions}
              selected={healthFilter}
              onSelect={(value) => {
                if (!isHealthFilterValue(value)) return;
                setParam('health', toggleIn(healthFilter, value, healthOrder));
              }}
            />
            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete('status');
                  next.delete('owner');
                  next.delete('health');
                  next.delete('team');
                  setParams(next, { replace: true });
                }}
              >
                <LuX aria-hidden="true" />
                Clear
              </Button>
            )}
            <div className="ml-auto flex items-center gap-1">
              <InitiativesDisplayMenu
                grouping={display.grouping}
                onGroupingChange={(value) => {
                  changeDisplay({ grouping: value });
                }}
                ordering={display.order}
                onOrderingChange={(value) => {
                  changeDisplay({ order: value });
                }}
                completed={display.completed}
                onCompletedChange={(value) => {
                  changeDisplay({ completed: value });
                }}
                columns={shown}
                onColumnsChange={(value) => {
                  changeDisplay({ columns: initiativeColumnValue(value) });
                }}
                onReset={reset}
              />
            </div>
          </div>
        ) : undefined
      }
    >
      {error != null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load the initiatives.')}
          />
        </div>
      )}
      <div>
        <div
          role="presentation"
          style={gridStyle(shown)}
          className={cn(
            GRID,
            'sticky top-0 z-20 h-8 border-b border-line bg-bg px-4 text-2xs font-medium tracking-wide text-text-faint uppercase lg:px-6'
          )}
        >
          <span>Name</span>
          {shown.includes('health') && (
            <span className="hidden truncate text-center md:block">
              {INITIATIVE_COLUMN_LABELS.health}
            </span>
          )}
          {shown.includes('team') && (
            <span className="hidden truncate md:block">
              {INITIATIVE_COLUMN_LABELS.team}
            </span>
          )}
          {shown.includes('owner') && (
            <span className="hidden truncate text-center md:block">
              {INITIATIVE_COLUMN_LABELS.owner}
            </span>
          )}
          {shown.includes('projects') && (
            <span className="hidden md:block">Projects</span>
          )}
          {shown.includes('target') && (
            <span className="hidden md:block">Target</span>
          )}
          {shown.includes('progress') && (
            <span className="text-right">
              <span className="hidden md:inline">Progress</span>
            </span>
          )}
        </div>
        {!isMember ? (
          <EmptyState
            icon={<LuGoal />}
            message="Initiatives are open to workspace members, not guests."
          />
        ) : isLoading && initiatives.length === 0 ? (
          <SkeletonRows label="Loading initiatives" />
        ) : groups.length === 0 && error == null ? (
          initiatives.length > 0 ? (
            <EmptyState
              icon={<LuGoal />}
              message={
                hasFilters
                  ? 'No initiatives match these filters.'
                  : 'Every initiative here is completed, and completed initiatives are hidden.'
              }
            />
          ) : (
            <EmptyState
              icon={<LuGoal />}
              message="No initiatives yet. An initiative groups projects across teams toward one goal."
            />
          )
        ) : (
          groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <div className="sticky top-8 z-10 flex h-9 items-center gap-2 border-b border-line bg-surface px-4 text-sm font-medium text-text lg:px-6">
                {group.icon}
                <span>{group.label}</span>
                <span className="text-xs font-normal text-text-faint tabular-nums">
                  {String(group.count)}
                </span>
              </div>
              <ul>
                {group.tree.map((row) => (
                  <InitiativeRow
                    key={row.initiative.initiative_id}
                    row={row}
                    slug={slug}
                    people={members}
                    teams={teams}
                    shown={shown}
                    collapsed={collapsed.has(row.initiative.initiative_id)}
                    onToggle={toggle}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {isCreating && (
        <CreateInitiativeDialog
          workspaceId={workspaceId}
          people={members}
          initialOwnerId={user?.id ?? null}
          teams={writableTeams}
          initialTeamId={
            filteredTeam !== undefined && writableTeams.includes(filteredTeam)
              ? filteredTeam.id
              : null
          }
          onClose={() => {
            setIsCreating(false);
          }}
          onCreated={(initiative) => {
            setIsCreating(false);
            invalidateQueries(queryKey);
            void navigate(initiativePath(slug, initiative.initiative_id));
          }}
        />
      )}
    </WorkspaceShell>
  );
};

export default Initiatives;
