/**
 * One initiative: its name, goal and properties, a rollup of how its projects
 * are progressing and tracking, the projects themselves with a way to add and
 * remove them, and the written updates its owner posts on a cadence.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuCalendarCheck,
  LuChevronRight,
  LuEllipsis,
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
  removeInitiativeProject,
  updateInitiative,
} from '../../api/initiatives';
import { DatePicker } from '../../components/issues/PropertyPickers';
import DocumentsSection from '../../components/planning/DocumentsSection';
import EditableText from '../../components/planning/EditableText';
import ProgressRing from '../../components/planning/ProgressRing';
import ProjectHealthGlyph from '../../components/planning/ProjectHealthGlyph';
import ProjectIcon from '../../components/planning/ProjectIcon';
import {
  CadencePicker,
  HealthPicker,
  InitiativeStatusPicker,
  LeadPicker,
} from '../../components/planning/ProjectPickers';
import ProjectStatusGlyph from '../../components/planning/ProjectStatusGlyph';
import ProjectUpdatesFeed from '../../components/planning/ProjectUpdatesFeed';
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
import { useInitiativeUpdates } from '../../hooks/useInitiativeUpdates';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { useWorkspaceProjects } from '../../hooks/useWorkspaceProjects';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { useOptimisticRecord } from '../../lib/optimistic';
import { initiativesPath, projectPath } from '../../lib/paths';
import {
  PROJECT_STATUS_LABELS,
  completionPercent,
} from '../../lib/planningDisplay';
import { canEditProject } from '../../lib/planningModel';
import { shortDateLabel } from '../../lib/propertyOptions';
import { initiativeDetailKey, initiativesKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type {
  HealthBreakdownRead,
  InitiativeRead,
  InitiativeUpdate,
  ProjectHealth,
} from '../../types/Api';

/** How often the initiative re-reads. */
const POLL_MS = 30000;

/** The tabs an initiative page has. */
type InitiativeTab = 'overview' | 'updates';

/** Reads the tab from the URL, defaulting to the overview. */
const tabFrom = (value: string | null): InitiativeTab =>
  value === 'updates' ? 'updates' : 'overview';

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

/** Props for RollupPanel: the initiative whose projects it sums up. */
interface RollupPanelProps {
  initiative: InitiativeRead;
}

/** The side panel summing the initiative's projects' progress and health. */
const RollupPanel: React.FC<RollupPanelProps> = ({ initiative }) => {
  const percent = completionPercent(initiative.counts);
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
          <dt>Issues</dt>
          <dd className="text-right">{String(initiative.counts.total)}</dd>
          <dt>Done</dt>
          <dd className="text-right">{String(initiative.counts.done)}</dd>
          <dt>In progress</dt>
          <dd className="text-right">
            {String(initiative.counts.in_progress)}
          </dd>
          <dt>To do</dt>
          <dd className="text-right">{String(initiative.counts.todo)}</dd>
        </dl>
      </section>
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

  const members = useMemo(
    () => projects.filter((project) => project.initiative_id === initiativeId),
    [projects, initiativeId]
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

  const crumbs = (
    <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
      <Link
        to={initiativesPath(slug)}
        className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
      >
        Initiatives
      </Link>
      <LuChevronRight
        className="h-3.5 w-3.5 text-text-faint"
        aria-hidden="true"
      />
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

  const properties = (
    <div
      role="group"
      aria-label="Properties"
      className="flex flex-wrap items-center gap-1.5"
    >
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
      leading={crumbs}
      flush
      toolbar={
        <div role="tablist" aria-label="Initiative" className="flex gap-1">
          {(['overview', 'updates'] as const).map((value) => (
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
              {value === 'overview' ? 'Overview' : 'Updates'}
            </button>
          ))}
        </div>
      }
      actions={
        canDelete ? (
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
        ) : undefined
      }
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not refresh this initiative.')}
          />
        </div>
      )}
      {tab === 'updates' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
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
          />
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
              <section aria-labelledby="initiative-projects">
                <div className="mb-2 flex items-center justify-between">
                  <h2
                    id="initiative-projects"
                    className="text-sm font-medium text-text"
                  >
                    Projects
                  </h2>
                  {candidates.length > 0 && (
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
                  )}
                </div>
                {membershipError !== null && (
                  <ErrorAlert
                    message={errorMessage(
                      membershipError,
                      'Could not change the initiative projects.'
                    )}
                  />
                )}
                {members.length === 0 ? (
                  <p className="text-xs text-text-muted">
                    {isLoadingProjects
                      ? 'Loading projects...'
                      : 'No projects are in this initiative yet.'}
                  </p>
                ) : (
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {members.map((project) => {
                      const percent = completionPercent(project.counts);
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
            <RollupPanel initiative={initiative} />
          </div>
        </div>
      )}

      {isConfirmingDelete && canDelete && (
        <Dialog
          open
          size="sm"
          title={`Delete ${initiative.name}`}
          description="Its projects stay where they are and stop being part of an initiative."
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
