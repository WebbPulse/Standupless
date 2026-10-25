/**
 * One initiative: its name, goal and properties, a rollup of how its projects
 * are progressing and tracking, the projects themselves with a way to add and
 * remove them, and the written updates its owner posts on a cadence. An
 * initiative may sit under a parent and hold sub-initiatives of its own: the
 * breadcrumbs walk up the chain, and the projects, rollup and progress graph
 * take in every sub-initiative below it. The Projects tab lays the projects
 * out through the projects page itself, as a list, board or timeline with its
 * filters and display options kept in the URL, and can leave out the
 * projects of sub-initiatives.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuCalendarCheck,
  LuChevronRight,
  LuEllipsis,
  LuGoal,
  LuPlus,
  LuTrash2,
  LuX,
} from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  addInitiativeProject,
  deleteInitiative,
  getInitiative,
  getInitiativeProgress,
  removeInitiativeProject,
  updateInitiative,
} from '../../api/initiatives';
import { DatePicker } from '../../components/issues/PropertyPickers';
import BurnUpChart from '../../components/planning/BurnUpChart';
import CreateInitiativeDialog from '../../components/planning/CreateInitiativeDialog';
import DocumentsSection from '../../components/planning/DocumentsSection';
import EditableText from '../../components/planning/EditableText';
import ProgressRing from '../../components/planning/ProgressRing';
import ProjectHealthGlyph from '../../components/planning/ProjectHealthGlyph';
import ProjectIcon from '../../components/planning/ProjectIcon';
import {
  CadencePicker,
  HealthPicker,
  InitiativePicker,
  InitiativeStatusPicker,
  LeadPicker,
} from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import ProjectUpdatesFeed from '../../components/planning/ProjectUpdatesFeed';
import { DocumentLinkContext } from '../../contexts/DocumentLinkContext';
import { ErrorAlert } from '../../components/ui/alert';
import Button, { IconButton } from '../../components/ui/button';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import Menu, { MenuItem } from '../../components/ui/menu';
import { Popover } from '../../components/ui/popover';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useAuth } from '../../hooks/useAuth';
import useCreateDocumentCommand from '../../hooks/useCreateDocumentCommand';
import useDocumentTemplates from '../../hooks/useDocumentTemplates';
import { useInitiativeUpdates } from '../../hooks/useInitiativeUpdates';
import { useInitiatives } from '../../hooks/useInitiatives';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { descendantIds, parentCandidates } from '../../lib/initiativeTree';
import { useOptimisticRecord } from '../../lib/optimistic';
import { initiativePath, initiativesPath, projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  progressMeasureOf,
  progressOf,
  progressPercent,
} from '../../lib/planningDisplay';
import { canEditProject, daysBetween } from '../../lib/planningModel';
import { shortDateLabel } from '../../lib/propertyOptions';
import {
  initiativeDetailKey,
  initiativeProgressKey,
  initiativesKey,
} from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import FavoriteButton from '../../components/ui/FavoriteButton';
import FollowButton from '../../components/planning/FollowButton';
import { Projects, type ProjectsScope } from './Projects';
import type {
  HealthBreakdownRead,
  InitiativeRead,
  InitiativeUpdate,
  ProjectHealth,
} from '../../types/Api';

/** How often the initiative re-reads. */
const POLL_MS = 30000;

/** The tabs an initiative page has. */
type InitiativeTab = 'overview' | 'projects' | 'updates';

/** The tabs in the order the page shows them, with their labels. */
const TABS: { value: InitiativeTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'projects', label: 'Projects' },
  { value: 'updates', label: 'Updates' },
];

/** Reads the tab from the URL, defaulting to the overview. */
const tabFrom = (value: string | null): InitiativeTab =>
  value === 'updates' || value === 'projects' ? value : 'overview';

/** The URL parameter that leaves sub-initiative projects out of the Projects tab when `0`. */
const SUB_INITIATIVES_PARAM = 'sub_initiatives';

/** How each slice of the health mix reads and is coloured. */
const HEALTH_MIX: {
  key: keyof HealthBreakdownRead;
  label: string;
  tone: string;
  health: ProjectHealth | null;
}[] = [
  {
    key: 'on_track',
    label: 'On track',
    tone: 'bg-success',
    health: 'on_track',
  },
  { key: 'at_risk', label: 'At risk', tone: 'bg-warning', health: 'at_risk' },
  {
    key: 'off_track',
    label: 'Off track',
    tone: 'bg-danger',
    health: 'off_track',
  },
  { key: 'none', label: 'No update', tone: 'bg-line', health: null },
];

/** Props for ProgressGraph: the initiative whose subtree it charts. */
interface ProgressGraphProps {
  workspaceId: string;
  initiative: InitiativeRead;
}

/**
 * Scope, started and completed work per day across every project in the
 * initiative's subtree, drawn through to the target date when one is ahead.
 */
const ProgressGraph: React.FC<ProgressGraphProps> = ({
  workspaceId,
  initiative,
}) => {
  const auth = useQueryAuth();
  const initiativeId = initiative.initiative_id;
  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getInitiativeProgress(workspaceId, initiativeId, signal),
    [workspaceId, initiativeId]
  );
  const { data, error, isLoading } = usePolledQuery(read, {
    intervalMs: POLL_MS * 2,
    enabled: workspaceId !== '' && initiativeId !== '',
    queryKey: initiativeProgressKey(workspaceId, initiativeId),
    auth,
  });
  const days = useMemo(
    () => (data !== null ? daysBetween(data.start_date, data.end_date) : []),
    [data]
  );
  return (
    <section className="space-y-2" data-testid="initiative-progress-graph">
      <h2 className="text-xs font-medium text-text-muted">Progress graph</h2>
      {error !== null && data === null ? (
        <p className="text-xs text-text-muted">
          {errorMessage(error, 'Could not load the progress graph.')}
        </p>
      ) : (
        <BurnUpChart
          points={data?.days ?? []}
          days={days}
          unit={data?.measure ?? 'issues'}
          emptyMessage="No issues in these projects yet, so there is nothing to chart."
          isLoading={isLoading && data === null}
        />
      )}
    </section>
  );
};

/** Props for RollupPanel: the initiative whose projects it sums up. */
interface RollupPanelProps {
  workspaceId: string;
  initiative: InitiativeRead;
}

/** The side panel summing the initiative's projects' progress and health. */
const RollupPanel: React.FC<RollupPanelProps> = ({
  workspaceId,
  initiative,
}) => {
  const percent = progressPercent(initiative);
  const progress = progressOf(initiative);
  const measure = progressMeasureOf(initiative);
  const healthTotal = HEALTH_MIX.reduce(
    (sum, slice) => sum + initiative.project_health[slice.key],
    0
  );
  return (
    <aside aria-label="Progress" className="w-full shrink-0 space-y-6 lg:w-72">
      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Progress</h2>
        <div className="flex items-center gap-2 text-sm text-text tabular-nums">
          <ProgressRing percent={percent} size={18} />
          <span>{`${String(percent)}% complete`}</span>
        </div>
        <dl className="grid grid-cols-2 gap-y-1 text-xs text-text-muted tabular-nums">
          <dt>{measure === 'points' ? 'Points' : 'Issues'}</dt>
          <dd className="text-right">{String(progress.total)}</dd>
          <dt>Done</dt>
          <dd className="text-right">{String(progress.done)}</dd>
          <dt>In progress</dt>
          <dd className="text-right">{String(progress.in_progress)}</dd>
          <dt>To do</dt>
          <dd className="text-right">{String(progress.todo)}</dd>
        </dl>
        {(initiative.sub_initiative_ids?.length ?? 0) > 0 && (
          <p className="text-2xs text-text-faint">
            Includes the projects of every sub-initiative.
          </p>
        )}
      </section>
      <ProgressGraph workspaceId={workspaceId} initiative={initiative} />
      <section className="space-y-2">
        <h2 className="text-xs font-medium text-text-muted">Project health</h2>
        {healthTotal > 0 && (
          <div
            aria-hidden="true"
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-raised"
          >
            {HEALTH_MIX.map((slice) =>
              initiative.project_health[slice.key] === 0 ? null : (
                <span
                  key={slice.key}
                  className={slice.tone}
                  style={{
                    width: `${String((initiative.project_health[slice.key] / healthTotal) * 100)}%`,
                  }}
                />
              )
            )}
          </div>
        )}
        <ul className="space-y-1 text-xs text-text-muted">
          {HEALTH_MIX.map((slice) => (
            <li key={slice.key} className="flex items-center gap-2">
              <ProjectHealthGlyph health={slice.health} />
              <span className="flex-1">{slice.label}</span>
              <span className="tabular-nums">
                {String(initiative.project_health[slice.key])}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
};

/** One initiative's overview, projects and updates. */
export const InitiativeDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const slug = workspace?.slug ?? '';
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const { teams, workspaceId, isLoading: isResolving } = useTeam(undefined);
  const initiativeId = id ?? '';
  const tab = tabFrom(params.get('tab'));
  const isMember = workspace !== null && workspace.role !== 'guest';
  const [composing, setComposing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [membershipError, setMembershipError] = useState<unknown>(null);
  const [nestingError, setNestingError] = useState<unknown>(null);
  const [isCreatingChild, setIsCreatingChild] = useState(false);

  const detailKey = initiativeDetailKey(workspaceId, initiativeId);
  const listKey = initiativesKey(workspaceId, '');

  const read = useCallback(
    ({ signal }: { signal?: AbortSignal }) =>
      getInitiative(workspaceId, initiativeId, signal),
    [workspaceId, initiativeId]
  );
  const {
    data: server,
    error,
    isLoading,
  } = usePolledQuery(read, {
    intervalMs: POLL_MS,
    enabled: isMember && workspaceId !== '' && initiativeId !== '',
    queryKey: detailKey,
    auth,
  });

  const { value: initiative, update } = useOptimisticRecord<
    InitiativeRead,
    InitiativeUpdate
  >(server ?? null, {
    write: (patch) => updateInitiative(workspaceId, initiativeId, patch),
    isSame: (left, right) => left.initiative_id === right.initiative_id,
    invalidate: [detailKey, listKey],
    failureMessage: (failure) =>
      errorMessage(
        failure,
        'Could not update the initiative. It has been undone.'
      ),
  });

  const people = useWorkspaceMembers(workspaceId, isMember);
  const {
    projects,
    isLoading: isLoadingProjects,
    queryKey: projectsQueryKey,
  } = useWorkspaceProjects(workspaceId, '', isMember);
  const updates = useInitiativeUpdates(
    workspaceId,
    initiativeId,
    initiative !== null
  );
  const updateTemplates = useDocumentTemplates(
    workspaceId,
    'initiative',
    initiativeId,
    initiative !== null
  );

  const { initiatives: allInitiatives } = useInitiatives(workspaceId, isMember);
  const initiativeNames = useMemo(
    () => new Map(allInitiatives.map((row) => [row.initiative_id, row.name])),
    [allInitiatives]
  );
  const below = useMemo(
    () => descendantIds(allInitiatives, initiativeId),
    [allInitiatives, initiativeId]
  );
  const subInitiatives = useMemo(
    () =>
      allInitiatives.filter(
        (row) => (row.parent_initiative_id ?? null) === initiativeId
      ),
    [allInitiatives, initiativeId]
  );
  const adoptable: ComboboxOption[] = useMemo(() => {
    const self = allInitiatives.find(
      (row) => row.initiative_id === initiativeId
    );
    if (self === undefined) return [];
    return allInitiatives
      .filter(
        (row) =>
          (row.parent_initiative_id ?? null) !== initiativeId &&
          parentCandidates(allInitiatives, row).some(
            (candidate) => candidate.initiative_id === initiativeId
          )
      )
      .map((row): ComboboxOption => {
        const parentId = row.parent_initiative_id ?? null;
        return {
          value: row.initiative_id,
          label: row.name,
          icon: <LuGoal className="h-3.5 w-3.5" />,
          ...(parentId === null
            ? {}
            : {
                detail: `in ${initiativeNames.get(parentId) ?? 'another initiative'}`,
              }),
        };
      });
  }, [allInitiatives, initiativeId, initiativeNames]);

  const members = useMemo(
    () => projects.filter((project) => project.initiative_id === initiativeId),
    [projects, initiativeId]
  );
  const rolledUp = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.initiative_id !== null &&
          project.initiative_id !== undefined &&
          below.has(project.initiative_id)
      ),
    [projects, below]
  );
  const candidates: ComboboxOption[] = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            project.initiative_id !== initiativeId &&
            canEditProject(workspace?.role, project, teams)
        )
        .map((project) => ({
          value: project.project_id,
          label: project.name,
          icon: <ProjectIcon icon={project.icon} color={project.color} />,
        })),
    [projects, initiativeId, workspace?.role, teams]
  );

  const withSubInitiatives = params.get(SUB_INITIATIVES_PARAM) !== '0';
  const scopedInitiatives = useMemo(
    () => new Set([initiativeId, ...(withSubInitiatives ? [...below] : [])]),
    [initiativeId, withSubInitiatives, below]
  );

  const setTab = useCallback(
    (next: InitiativeTab): void => {
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

  useCreateDocumentCommand({
    workspaceId,
    slug,
    parentKind: 'initiative',
    parentId: initiativeId,
    group: 'Initiative',
    enabled: isMember && initiative !== null,
  });

  const ancestors = initiative?.ancestors ?? [];
  const crumbs = (
    <span className="hidden min-w-0 shrink items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={initiativesPath(slug)}
        className="shrink-0 rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Initiatives
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 shrink-0 text-text-faint"
        aria-hidden="true"
      />
      {ancestors.map((ancestor) => (
        <React.Fragment key={ancestor.initiative_id}>
          <Link
            to={initiativePath(slug, ancestor.initiative_id)}
            className="max-w-40 truncate rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            {ancestor.name}
          </Link>
          <LuChevronRight
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
            aria-hidden="true"
          />
        </React.Fragment>
      ))}
    </span>
  );

  if (isMember && (isResolving || (isLoading && initiative === null))) {
    return (
      <WorkspaceShell title="Initiative" leading={crumbs}>
        <SkeletonRows label="Loading initiative" />
      </WorkspaceShell>
    );
  }

  if (initiative === null) {
    return (
      <WorkspaceShell title="Initiative not found" leading={crumbs}>
        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load this initiative.')}
          />
        )}
        <EmptyState message="That initiative does not exist, or you do not have access to it." />
      </WorkspaceShell>
    );
  }

  const canEdit = isMember;
  const role = workspace?.role;
  const userId = user?.id;
  const canDelete =
    role === 'owner' ||
    role === 'admin' ||
    (userId !== undefined &&
      (userId === initiative.created_by || userId === initiative.owner_id));
  const workspaceCadence = workspace?.project_update_interval_days ?? 7;

  const refreshMembership = (): void => {
    invalidateQueries(detailKey);
    invalidateQueries(listKey);
    invalidateQueries(projectsQueryKey);
  };

  const addProject = (projectId: string): void => {
    setMembershipError(null);
    addInitiativeProject(workspaceId, initiativeId, projectId).then(
      refreshMembership,
      (failure: unknown) => {
        setMembershipError(failure);
      }
    );
  };

  const removeProject = (projectId: string): void => {
    setMembershipError(null);
    removeInitiativeProject(workspaceId, initiativeId, projectId).then(
      refreshMembership,
      (failure: unknown) => {
        setMembershipError(failure);
      }
    );
  };

  const refreshNesting = (): void => {
    invalidateQueries(detailKey);
    invalidateQueries(listKey);
    invalidateQueries(initiativeProgressKey(workspaceId, initiativeId));
  };

  const setChildParent = (childId: string, parentId: string | null): void => {
    setNestingError(null);
    updateInitiative(workspaceId, childId, {
      parent_initiative_id: parentId,
    }).then(
      () => {
        refreshNesting();
        invalidateQueries(initiativeDetailKey(workspaceId, childId));
      },
      (failure: unknown) => {
        setNestingError(failure);
      }
    );
  };

  const remove = (): void => {
    setDeleteError(null);
    deleteInitiative(workspaceId, initiativeId).then(
      () => {
        setIsConfirmingDelete(false);
        invalidateQueries(listKey);
        invalidateQueries(projectsQueryKey);
        showToast(`Deleted ${initiative.name}`);
        void navigate(initiativesPath(slug));
      },
      (failure: unknown) => {
        setDeleteError(failure);
      }
    );
  };

  const addProjectButton = candidates.length > 0 && (
    <Popover
      label="Add project"
      align="end"
      contentClassName="w-64"
      trigger={(trigger) => (
        <Button variant="ghost" size="sm" {...trigger}>
          <LuPlus aria-hidden="true" />
          Add project
        </Button>
      )}
    >
      {(close) => (
        <Combobox
          label="Add project"
          placeholder="Add project..."
          options={candidates}
          selected={[]}
          onSelect={(projectId) => {
            close();
            addProject(projectId);
          }}
        />
      )}
    </Popover>
  );

  const membershipAlert = membershipError !== null && (
    <ErrorAlert
      message={errorMessage(
        membershipError,
        'Could not change the initiative projects.'
      )}
    />
  );

  const projectsScope: ProjectsScope = {
    includes: (project) =>
      project.initiative_id !== null &&
      project.initiative_id !== undefined &&
      scopedInitiatives.has(project.initiative_id),
    initiativeIds: scopedInitiatives,
    preset: { initiative_id: initiativeId },
    emptyMessage: withSubInitiatives
      ? 'No projects are in this initiative yet.'
      : 'No projects are in this initiative itself yet.',
    onCreated: refreshMembership,
    actions: (
      <>
        {below.size > 0 && (
          <Button
            size="sm"
            variant="secondary"
            aria-pressed={withSubInitiatives}
            data-testid="sub-initiative-roll-up"
            onClick={() => {
              setParams(
                (current) => {
                  const held = new URLSearchParams(current);
                  if (withSubInitiatives) held.set(SUB_INITIATIVES_PARAM, '0');
                  else held.delete(SUB_INITIATIVES_PARAM);
                  return held;
                },
                { replace: true }
              );
            }}
          >
            {withSubInitiatives
              ? 'Including sub-initiatives'
              : 'This initiative only'}
          </Button>
        )}
        {addProjectButton}
      </>
    ),
  };

  const properties = (
    <div
      role="group"
      aria-label="Properties"
      className="flex flex-wrap items-center gap-1.5"
    >
      <InitiativePicker
        variant="chip"
        field="Parent"
        value={initiative.parent_initiative_id ?? null}
        valueName={ancestors[ancestors.length - 1]?.name ?? null}
        initiatives={parentCandidates(allInitiatives, initiative)}
        disabled={!canEdit}
        onChange={(parentId) => {
          void update({ parent_initiative_id: parentId }).then(() => {
            invalidateQueries(initiativeProgressKey(workspaceId, initiativeId));
          });
        }}
      />
      <InitiativeStatusPicker
        variant="chip"
        value={initiative.status}
        disabled={!canEdit}
        onChange={(status) => {
          void update({ status });
        }}
      />
      <HealthPicker
        variant="chip"
        value={initiative.health}
        disabled={!canEdit}
        onChange={(health) => {
          void update({ health });
        }}
      />
      <LeadPicker
        variant="chip"
        field="Owner"
        value={initiative.owner_id}
        people={people}
        disabled={!canEdit}
        onChange={(ownerId) => {
          void update({ owner_id: ownerId });
        }}
      />
      <DatePicker
        variant="chip"
        field="Target date"
        value={initiative.target_date}
        disabled={!canEdit}
        icon={<LuCalendarCheck className="h-3.5 w-3.5" />}
        onChange={(value) => {
          void update({ target_date: value });
        }}
      />
      <CadencePicker
        variant="chip"
        value={initiative.update_interval_days}
        inherited={initiative.update_interval_inherited}
        workspaceDefault={workspaceCadence}
        disabled={!canEdit}
        onChange={(interval) => {
          void update({ update_interval_days: interval });
        }}
      />
    </div>
  );

  return (
    <WorkspaceShell
      title={<span className="truncate">{initiative.name}</span>}
      titleAccessory={
        <FavoriteButton
          workspaceId={workspaceId}
          kind="initiative"
          targetId={initiative.initiative_id}
          title={initiative.name}
        />
      }
      leading={crumbs}
      flush
      toolbar={
        <div role="tablist" aria-label="Initiative" className="flex gap-1">
          {TABS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => {
                setTab(value);
              }}
              className={cn(
                'rounded-md px-2 py-1 text-sm transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                tab === value
                  ? 'bg-raised text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      }
      actions={
        <div className="flex items-center gap-1">
          <FollowButton
            workspaceId={workspaceId}
            subject="initiative"
            subjectId={initiative.initiative_id}
          />
          {canDelete && (
            <Menu
              label="Initiative actions"
              align="end"
              trigger={(trigger) => (
                <IconButton label="Initiative actions" size="sm" {...trigger}>
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
                Delete initiative
              </MenuItem>
            </Menu>
          )}
        </div>
      }
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not refresh this initiative.')}
          />
        </div>
      )}
      {tab === 'projects' ? (
        <>
          {membershipError !== null && (
            <div className="px-4 pt-3 lg:px-6">{membershipAlert}</div>
          )}
          <Projects scope={projectsScope} />
        </>
      ) : tab === 'updates' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DocumentLinkContext.Provider
            value={{ kind: 'initiative', id: initiative.initiative_id }}
          >
            <ProjectUpdatesFeed
              feed={updates}
              people={people}
              subject="initiative"
              canPost={canEdit}
              defaultHealth={initiative.health ?? 'on_track'}
              dueState={initiative.update_due_state}
              dueAt={initiative.next_update_due_at}
              composing={composing}
              onComposingChange={setComposing}
              templates={updateTemplates.templates}
              defaultTemplate={updateTemplates.defaultUpdate}
            />
          </DocumentLinkContext.Provider>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 lg:flex-row lg:px-8">
            <div className="min-w-0 flex-1 space-y-8">
              <div className="space-y-3">
                <EditableText
                  label="Initiative name"
                  placeholder="Initiative name"
                  value={initiative.name}
                  disabled={!canEdit}
                  className="text-2xl font-semibold"
                  onSave={(name) => {
                    if (name !== '') void update({ name });
                  }}
                />
                {properties}
                <EditableText
                  multiline
                  label="Description"
                  placeholder={
                    canEdit
                      ? 'Add a description, the goal and what done looks like...'
                      : 'No description.'
                  }
                  value={initiative.description ?? ''}
                  disabled={!canEdit}
                  className="text-sm leading-relaxed text-text-muted"
                  onSave={(description) => {
                    void update({
                      description: description === '' ? null : description,
                    });
                  }}
                />
              </div>
              <section aria-labelledby="initiative-sub-initiatives">
                <div className="mb-2 flex items-center justify-between">
                  <h2
                    id="initiative-sub-initiatives"
                    className="text-sm font-medium text-text"
                  >
                    Sub-initiatives
                  </h2>
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      {adoptable.length > 0 && (
                        <Popover
                          label="Add sub-initiative"
                          align="end"
                          contentClassName="w-64"
                          trigger={(trigger) => (
                            <Button variant="ghost" size="sm" {...trigger}>
                              <LuPlus aria-hidden="true" />
                              Add existing
                            </Button>
                          )}
                        >
                          {(close) => (
                            <Combobox
                              label="Add sub-initiative"
                              placeholder="Add sub-initiative..."
                              options={adoptable}
                              selected={[]}
                              onSelect={(childId) => {
                                close();
                                setChildParent(childId, initiativeId);
                              }}
                            />
                          )}
                        </Popover>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setIsCreatingChild(true);
                        }}
                      >
                        <LuPlus aria-hidden="true" />
                        New sub-initiative
                      </Button>
                    </div>
                  )}
                </div>
                {nestingError !== null && (
                  <ErrorAlert
                    message={errorMessage(
                      nestingError,
                      'Could not change the sub-initiatives.'
                    )}
                  />
                )}
                {subInitiatives.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    No sub-initiatives yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {subInitiatives.map((child) => {
                      const percent = progressPercent(child);
                      const nested = child.sub_initiative_ids?.length ?? 0;
                      return (
                        <li
                          key={child.initiative_id}
                          className="flex h-10 items-center gap-2.5 px-3 text-sm"
                        >
                          <LuGoal
                            aria-hidden="true"
                            className="h-3.5 w-3.5 shrink-0 text-text-muted"
                          />
                          <Link
                            to={initiativePath(slug, child.initiative_id)}
                            className="min-w-0 flex-1 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                          >
                            {child.name}
                          </Link>
                          {nested > 0 && (
                            <span className="hidden text-xs text-text-faint tabular-nums sm:inline">
                              {`${String(nested)} sub-${nested === 1 ? 'initiative' : 'initiatives'}`}
                            </span>
                          )}
                          <ProjectHealthGlyph health={child.health} />
                          <span className="hidden w-16 text-xs text-text-muted tabular-nums sm:block">
                            {`${String(child.project_count)} ${child.project_count === 1 ? 'project' : 'projects'}`}
                          </span>
                          <span className="flex w-12 items-center justify-end gap-1 text-xs text-text-muted tabular-nums">
                            <ProgressRing percent={percent} />
                            {`${String(percent)}%`}
                          </span>
                          {canEdit && (
                            <IconButton
                              label={`Remove ${child.name} from this initiative`}
                              size="sm"
                              onClick={() => {
                                setChildParent(child.initiative_id, null);
                              }}
                            >
                              <LuX className="h-3.5 w-3.5" />
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section aria-labelledby="initiative-projects">
                <div className="mb-2 flex items-center justify-between">
                  <h2
                    id="initiative-projects"
                    className="text-sm font-medium text-text"
                  >
                    Projects
                  </h2>
                  {addProjectButton}
                </div>
                {membershipAlert}
                {members.length === 0 && rolledUp.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    {isLoadingProjects
                      ? 'Loading projects...'
                      : 'No projects are in this initiative yet.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {members.map((project) => {
                      const percent = progressPercent(project);
                      return (
                        <li
                          key={project.project_id}
                          className="flex h-10 items-center gap-2.5 px-3 text-sm"
                        >
                          <ProjectIcon
                            icon={project.icon}
                            color={project.color}
                          />
                          <Link
                            to={projectPath(slug, project.project_id)}
                            className="min-w-0 flex-1 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                          >
                            {project.name}
                          </Link>
                          <ProjectHealthGlyph health={project.health} />
                          <ProjectStatusGlyph
                            status={project.status}
                            percent={percent}
                            name={PROJECT_STATUS_LABELS[project.status]}
                          />
                          <span className="hidden w-16 text-xs text-text-muted tabular-nums sm:block">
                            {project.target_date === null
                              ? 'No date'
                              : shortDateLabel(project.target_date)}
                          </span>
                          <span className="flex w-12 items-center justify-end gap-1 text-xs text-text-muted tabular-nums">
                            <ProgressRing percent={percent} />
                            {`${String(percent)}%`}
                          </span>
                          {canEditProject(workspace?.role, project, teams) && (
                            <IconButton
                              label={`Remove ${project.name}`}
                              size="sm"
                              onClick={() => {
                                removeProject(project.project_id);
                              }}
                            >
                              <LuX className="h-3.5 w-3.5" />
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                    {rolledUp.map((project) => {
                      const percent = progressPercent(project);
                      const via =
                        project.initiative_id === null ||
                        project.initiative_id === undefined
                          ? ''
                          : (initiativeNames.get(project.initiative_id) ?? '');
                      return (
                        <li
                          key={project.project_id}
                          className="flex h-10 items-center gap-2.5 px-3 text-sm"
                        >
                          <ProjectIcon
                            icon={project.icon}
                            color={project.color}
                          />
                          <Link
                            to={projectPath(slug, project.project_id)}
                            className="min-w-0 truncate font-medium text-text hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                          >
                            {project.name}
                          </Link>
                          <span className="min-w-0 flex-1 truncate text-xs text-text-faint">
                            {via === '' ? '' : `via ${via}`}
                          </span>
                          <ProjectHealthGlyph health={project.health} />
                          <ProjectStatusGlyph
                            status={project.status}
                            percent={percent}
                            name={PROJECT_STATUS_LABELS[project.status]}
                          />
                          <span className="hidden w-16 text-xs text-text-muted tabular-nums sm:block">
                            {project.target_date === null
                              ? 'No date'
                              : shortDateLabel(project.target_date)}
                          </span>
                          <span className="flex w-12 items-center justify-end gap-1 text-xs text-text-muted tabular-nums">
                            <ProgressRing percent={percent} />
                            {`${String(percent)}%`}
                          </span>
                          {canEdit && (
                            <span aria-hidden="true" className="w-6" />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <DocumentsSection
                workspaceId={workspaceId}
                slug={slug}
                parentKind="initiative"
                parentId={initiativeId}
                canCreate={canEdit}
                people={people}
              />
            </div>
            <RollupPanel workspaceId={workspaceId} initiative={initiative} />
          </div>
        </div>
      )}

      {isCreatingChild && (
        <CreateInitiativeDialog
          workspaceId={workspaceId}
          people={people}
          initialOwnerId={userId ?? null}
          parent={{
            initiative_id: initiative.initiative_id,
            name: initiative.name,
          }}
          onClose={() => {
            setIsCreatingChild(false);
          }}
          onCreated={(child) => {
            setIsCreatingChild(false);
            refreshNesting();
            showToast(`Created ${child.name}`);
          }}
        />
      )}

      {isConfirmingDelete && canDelete && (
        <Dialog
          open
          size="sm"
          title={`Delete ${initiative.name}`}
          description={
            (initiative.sub_initiative_ids?.length ?? 0) > 0
              ? 'Its projects stay where they are and stop being part of an initiative. Its sub-initiatives move up to its own parent.'
              : 'Its projects stay where they are and stop being part of an initiative.'
          }
          onClose={() => {
            setIsConfirmingDelete(false);
          }}
        >
          <div className="space-y-3">
            {deleteError !== null && (
              <ErrorAlert
                message={errorMessage(
                  deleteError,
                  'Could not delete this initiative.'
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
                Delete initiative
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default InitiativeDetail;
