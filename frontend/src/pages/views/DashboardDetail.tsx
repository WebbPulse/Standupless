/**
 * One dashboard: a grid of insight widgets over several teams and saved
 * views, with a shared filter on top of every widget's own. Editors drag
 * widgets into a new order, resize and edit them, narrow the shared filter,
 * and refile or hand over the dashboard. The filter bar can be hidden to give
 * the widgets the room; the filter keeps applying while it is hidden.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuChevronRight,
  LuEllipsis,
  LuEye,
  LuEyeOff,
  LuLayoutDashboard,
  LuPencil,
  LuPlus,
  LuRefreshCw,
  LuTrash2,
  LuUserCog,
  LuX,
} from 'react-icons/lu';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  addDashboardWidget,
  deleteDashboard,
  deleteDashboardWidget,
  getDashboard,
  reorderDashboardWidgets,
  updateDashboard,
  updateDashboardWidget,
} from '../../api/dashboards';
import { listViews, listsProjects } from '../../api/views';
import DashboardDialog from '../../components/dashboards/DashboardDialog';
import DashboardWidgetCard from '../../components/dashboards/DashboardWidgetCard';
import WidgetDialog from '../../components/dashboards/WidgetDialog';
import { ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { Menu, MenuItem, MenuSeparator } from '../../components/ui/menu';
import { Select } from '../../components/ui/select';
import { SkeletonRows } from '../../components/ui/skeleton';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import {
  DASHBOARD_POLL_MS,
  DASHBOARD_WIDGETS_MAX,
  dashboardLocation,
  filterChips,
  movedOrder,
  saveDashboardDetails,
  widgetSourceLabel,
  type DashboardDetails,
} from '../../lib/dashboards';
import { errorMessage, hasStatus, NOT_FOUND } from '../../lib/errors';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import { dashboardsPath } from '../../lib/paths';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import {
  dashboardKey,
  dashboardWidgetKey,
  dashboardsKey,
  viewsKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type {
  DashboardRead,
  DashboardWidgetCreate,
  DashboardWidgetRead,
} from '../../types/Api';

const FILTERS_HIDDEN_KEY = 'standupless.dashboard.filters-hidden';

/** Whether the caller last hid the filter bar, read leniently from the browser. */
const readFiltersHidden = (): boolean => {
  try {
    return window.localStorage.getItem(FILTERS_HIDDEN_KEY) === 'true';
  } catch {
    return false;
  }
};

/** Remembers whether the filter bar is hidden; a refused write is ignored. */
const writeFiltersHidden = (hidden: boolean): void => {
  try {
    window.localStorage.setItem(FILTERS_HIDDEN_KEY, hidden ? 'true' : 'false');
  } catch {
    return;
  }
};

/** The body that saves an existing widget back unchanged but for `change`. */
const widgetBody = (
  widget: DashboardWidgetRead,
  change: DashboardWidgetCreate = {}
): DashboardWidgetCreate => ({
  kind: widget.kind,
  title: widget.title,
  source: widget.source,
  team_id: widget.team_id,
  view_id: widget.view_id,
  include_sub_teams: widget.include_sub_teams,
  filter: widget.filter,
  group_by: widget.group_by,
  segment_by: widget.segment_by,
  measure: widget.measure,
  size: widget.size,
  ...change,
});

/** Which dialog is open over the dashboard. */
type Pending =
  | { kind: 'add' }
  | { kind: 'edit-widget'; widget: DashboardWidgetRead }
  | { kind: 'details' }
  | { kind: 'owner' }
  | { kind: 'delete' }
  | null;

/** The dashboard page. */
export const DashboardDetail: React.FC = () => {
  const { dashboardId = '' } = useParams<{ dashboardId: string }>();
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const members = useWorkspaceMembers(workspaceId);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [filtersHidden, setFiltersHidden] = useState(readFiltersHidden);
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [owner, setOwner] = useState('');

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getDashboard(workspaceId, dashboardId, signal),
    {
      intervalMs: DASHBOARD_POLL_MS,
      enabled: workspaceId !== '' && dashboardId !== '',
      queryKey: dashboardKey(workspaceId, dashboardId),
      auth,
    }
  );
  const [dashboard, setDashboard] = useState<DashboardRead | null>(null);
  useEffect(() => {
    if (data !== null) setDashboard(data);
  }, [data]);

  const { data: viewRows } = usePolledQuery(
    (context) => listViews(workspaceId, { scope: 'all' }, context),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: viewsKey(workspaceId, 'all', ''),
      auth,
    }
  );
  const views = useMemo(
    () => (viewRows ?? []).filter((view) => !listsProjects(view)),
    [viewRows]
  );
  const viewNames = useMemo(
    () => new Map(views.map((view) => [view.view_id, view.name])),
    [views]
  );

  const widgets = useMemo(() => {
    const rows = dashboard?.widgets ?? [];
    if (order === null) return rows;
    const byId = new Map(rows.map((widget) => [widget.widget_id, widget]));
    return order
      .map((id) => byId.get(id))
      .filter((widget): widget is DashboardWidgetRead => widget !== undefined);
  }, [dashboard, order]);

  const apply = (saved: DashboardRead): void => {
    setDashboard(saved);
    setOrder(null);
    invalidateQueries([
      dashboardKey(workspaceId, saved.id),
      dashboardsKey(workspaceId, 'all', ''),
      ...(saved.team_id === null
        ? []
        : [dashboardsKey(workspaceId, 'all', saved.team_id)]),
    ]);
  };

  const run = async (
    action: () => Promise<DashboardRead>,
    failure: string
  ): Promise<boolean> => {
    setBusy(true);
    try {
      apply(await action());
      return true;
    } catch (caught) {
      showErrorToast(errorMessage(caught, failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const refresh = (): void => {
    if (dashboard === null) return;
    invalidateQueries(
      dashboard.widgets.map((widget) =>
        dashboardWidgetKey(
          workspaceId,
          dashboard.id,
          widget.widget_id,
          dashboard.updated_at
        )
      )
    );
    void refetch();
  };

  const setFilter = (filter: Record<string, unknown>): void => {
    if (dashboard === null) return;
    void run(
      () => updateDashboard(workspaceId, dashboard.id, { filter }),
      'Could not change the filter.'
    );
  };

  const dropFilter = (key: string): void => {
    if (dashboard === null) return;
    const next = { ...dashboard.filter };
    delete next[key];
    setFilter(next);
  };

  const finishDrag = (): void => {
    const moving = dragging;
    setDragging(null);
    if (dashboard === null || moving === null || order === null) return;
    const before = dashboard.widgets.map((widget) => widget.widget_id);
    if (order.join() === before.join()) {
      setOrder(null);
      return;
    }
    void run(
      () => reorderDashboardWidgets(workspaceId, dashboard.id, order),
      'Could not reorder the widgets.'
    );
  };

  const saveDetails = async (details: DashboardDetails): Promise<void> => {
    if (dashboard === null) return;
    const done = await run(
      () => saveDashboardDetails(workspaceId, dashboard, details),
      'Could not update the dashboard.'
    );
    if (done) setPending(null);
  };

  const remove = async (): Promise<void> => {
    if (dashboard === null) return;
    setBusy(true);
    try {
      await deleteDashboard(workspaceId, dashboard.id);
      invalidateQueries([
        dashboardsKey(workspaceId, 'all', ''),
        ...(dashboard.team_id === null
          ? []
          : [dashboardsKey(workspaceId, 'all', dashboard.team_id)]),
      ]);
      showToast(`Deleted ${dashboard.name}.`);
      void navigate(dashboardsPath(slug));
    } catch (caught) {
      showErrorToast(errorMessage(caught, 'Could not delete the dashboard.'));
    } finally {
      setBusy(false);
    }
  };

  if (dashboard === null) {
    return (
      <WorkspaceShell title="Dashboard">
        {error !== null && !isLoading ? (
          hasStatus(error, NOT_FOUND) ? (
            <EmptyState message="That dashboard does not exist, or it is not shared with you." />
          ) : (
            <ErrorAlert
              message={errorMessage(error, 'Could not load the dashboard.')}
            />
          )
        ) : (
          <SkeletonRows />
        )}
      </WorkspaceShell>
    );
  }

  const canEdit = dashboard.can_edit;
  const chips = filterChips(dashboard.filter, teams);
  const storedTeam = dashboard.filter['team_id'];
  const filterTeam = typeof storedTeam === 'string' ? storedTeam : '';
  const storedPriority: unknown = dashboard.filter['priority'];
  const filterPriorities: string[] = Array.isArray(storedPriority)
    ? storedPriority.map((item) => String(item))
    : typeof storedPriority === 'string'
      ? [storedPriority]
      : [];
  const full = dashboard.widgets.length >= DASHBOARD_WIDGETS_MAX;

  return (
    <WorkspaceShell
      title={dashboard.name}
      tabTitle={dashboard.name}
      leading={
        <span className="hidden shrink-0 items-center gap-1 text-sm text-text-muted sm:inline-flex">
          <Link
            to={dashboardsPath(slug)}
            className="rounded-xs hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          >
            Dashboards
          </Link>
          <LuChevronRight
            className="h-3.5 w-3.5 text-text-faint"
            aria-hidden="true"
          />
        </span>
      }
      titleAccessory={
        <Badge tone="neutral" className="hidden sm:inline-flex">
          {dashboardLocation(dashboard, teams)}
        </Badge>
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            aria-pressed={!filtersHidden}
            onClick={() => {
              setFiltersHidden((hidden) => {
                writeFiltersHidden(!hidden);
                return !hidden;
              });
            }}
          >
            {filtersHidden ? (
              <LuEye aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <LuEyeOff aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {filtersHidden ? 'Show filters' : 'Hide filters'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={refresh}
          >
            <LuRefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            Refresh data
          </Button>
          {canEdit && (
            <Button
              size="sm"
              variant="primary"
              className="gap-1.5"
              disabled={full}
              title={
                full
                  ? `A dashboard holds up to ${DASHBOARD_WIDGETS_MAX} widgets.`
                  : undefined
              }
              onClick={() => {
                setPending({ kind: 'add' });
              }}
            >
              <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
              Add widget
            </Button>
          )}
          {canEdit && (
            <Menu
              label="Dashboard actions"
              align="end"
              trigger={(props) => (
                <IconButton {...props} label="Dashboard actions" size="sm">
                  <LuEllipsis aria-hidden="true" className="h-3.5 w-3.5" />
                </IconButton>
              )}
            >
              <MenuItem
                onSelect={() => {
                  setPending({ kind: 'details' });
                }}
              >
                <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                Edit or move
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setOwner(dashboard.owner_id);
                  setPending({ kind: 'owner' });
                }}
              >
                <LuUserCog aria-hidden="true" className="h-3.5 w-3.5" />
                Change owner
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                onSelect={() => {
                  setPending({ kind: 'delete' });
                }}
              >
                <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                Delete dashboard
              </MenuItem>
            </Menu>
          )}
        </div>
      }
      toolbar={
        filtersHidden ? (
          chips.length > 0 ? (
            <p className="text-xs text-text-muted">
              {chips.length === 1
                ? '1 filter applies to every widget.'
                : `${chips.length} filters apply to every widget.`}
            </p>
          ) : undefined
        ) : (
          <div
            role="group"
            aria-label="Dashboard filters"
            className="flex flex-wrap items-center gap-2"
          >
            {chips.map((chip) => (
              <span
                key={chip.key}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-line bg-surface pr-1 pl-2 text-xs text-text"
              >
                {chip.label}
                {canEdit && (
                  <IconButton
                    label={`Remove ${chip.label}`}
                    size="sm"
                    className="h-4 w-4"
                    disabled={busy}
                    onClick={() => {
                      dropFilter(chip.key);
                    }}
                  >
                    <LuX aria-hidden="true" className="h-3 w-3" />
                  </IconButton>
                )}
              </span>
            ))}
            {canEdit && (
              <>
                <Select
                  aria-label="Filter every widget by team"
                  value={filterTeam}
                  className="h-7 w-auto text-xs"
                  disabled={busy}
                  onChange={(event) => {
                    const next = { ...dashboard.filter };
                    if (event.target.value === '') delete next['team_id'];
                    else next['team_id'] = event.target.value;
                    setFilter(next);
                  }}
                >
                  <option value="">Any team</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </Select>
                <Select
                  aria-label="Filter every widget by priority"
                  value=""
                  className="h-7 w-auto text-xs"
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '' || filterPriorities.includes(value))
                      return;
                    setFilter({
                      ...dashboard.filter,
                      priority: [...filterPriorities, value],
                    });
                  }}
                >
                  <option value="">Add priority</option>
                  {PRIORITIES.filter(
                    (priority) => !filterPriorities.includes(priority)
                  ).map((priority) => (
                    <option key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </Select>
              </>
            )}
            {!canEdit && chips.length === 0 && (
              <p className="text-xs text-text-muted">
                No filter applies to every widget.
              </p>
            )}
          </div>
        )
      }
      flush
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6">
        {dashboard.description !== null && (
          <p className="mb-4 max-w-3xl text-sm text-text-muted">
            {dashboard.description}
          </p>
        )}
        {widgets.length === 0 ? (
          <EmptyState
            icon={<LuLayoutDashboard />}
            message={
              canEdit
                ? 'No widgets yet. Add one here, or use Add to dashboard from the insights panel of any issue list.'
                : 'No widgets yet.'
            }
            className="py-16"
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {widgets.map((widget) => (
              <DashboardWidgetCard
                key={widget.widget_id}
                workspaceId={workspaceId}
                dashboardId={dashboard.id}
                version={dashboard.updated_at}
                widget={widget}
                sourceLabel={widgetSourceLabel(
                  widget,
                  teams,
                  widget.view_id === null
                    ? undefined
                    : viewNames.get(widget.view_id)
                )}
                canEdit={canEdit}
                dragging={dragging === widget.widget_id}
                onEdit={() => {
                  setPending({ kind: 'edit-widget', widget });
                }}
                onResize={() => {
                  void run(
                    () =>
                      updateDashboardWidget(
                        workspaceId,
                        dashboard.id,
                        widget.widget_id,
                        widgetBody(widget, {
                          size: widget.size === 'full' ? 'half' : 'full',
                        })
                      ),
                    'Could not resize the widget.'
                  );
                }}
                onRemove={() => {
                  void run(
                    () =>
                      deleteDashboardWidget(
                        workspaceId,
                        dashboard.id,
                        widget.widget_id
                      ),
                    'Could not remove the widget.'
                  );
                }}
                onDragStart={() => {
                  setDragging(widget.widget_id);
                  setOrder(widgets.map((row) => row.widget_id));
                }}
                onDragEnter={() => {
                  if (dragging === null || dragging === widget.widget_id)
                    return;
                  setOrder((current) =>
                    movedOrder(
                      current ?? widgets.map((row) => row.widget_id),
                      dragging,
                      widget.widget_id
                    )
                  );
                }}
                onDragEnd={finishDrag}
              />
            ))}
          </div>
        )}
      </div>
      {pending?.kind === 'add' && (
        <WidgetDialog
          title="Add widget"
          submitLabel="Add widget"
          initial={{}}
          teams={teams}
          views={views}
          onClose={() => {
            setPending(null);
          }}
          onSave={async (body) => {
            const done = await run(
              () => addDashboardWidget(workspaceId, dashboard.id, body),
              'Could not add the widget.'
            );
            if (done) setPending(null);
          }}
        />
      )}
      {pending?.kind === 'edit-widget' && (
        <WidgetDialog
          title="Edit widget"
          submitLabel="Save changes"
          initial={widgetBody(pending.widget)}
          teams={teams}
          views={views}
          onClose={() => {
            setPending(null);
          }}
          onSave={async (body) => {
            const done = await run(
              () =>
                updateDashboardWidget(
                  workspaceId,
                  dashboard.id,
                  pending.widget.widget_id,
                  body
                ),
              'Could not save the widget.'
            );
            if (done) setPending(null);
          }}
        />
      )}
      {pending?.kind === 'details' && (
        <DashboardDialog
          title="Edit dashboard"
          submitLabel="Save changes"
          teams={teams}
          canShareWorkspace={workspace?.role !== 'guest'}
          initial={{
            name: dashboard.name,
            description: dashboard.description,
            scope: dashboard.scope,
            teamId: dashboard.team_id,
          }}
          onClose={() => {
            setPending(null);
          }}
          onSave={saveDetails}
        />
      )}
      {pending?.kind === 'owner' && (
        <Dialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Change owner"
          description={
            dashboard.scope === 'personal'
              ? 'A personal dashboard belongs to the person who made it. Move it to a team or the workspace first, then hand it over.'
              : 'The owner can always edit and delete this dashboard.'
          }
          size="sm"
        >
          <div className="flex flex-col gap-3">
            <Select
              aria-label="Owner"
              value={owner}
              disabled={dashboard.scope === 'personal'}
              onChange={(event) => {
                setOwner(event.target.value);
              }}
            >
              {members.map((member) => (
                <option key={member.user_id} value={member.user_id}>
                  {member.display_name ?? member.email}
                </option>
              ))}
            </Select>
            <div className="flex justify-end gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPending(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={
                  busy ||
                  dashboard.scope === 'personal' ||
                  owner === '' ||
                  owner === dashboard.owner_id
                }
                onClick={() => {
                  void run(
                    () =>
                      updateDashboard(workspaceId, dashboard.id, {
                        owner_id: owner,
                      }),
                    'Could not change the owner.'
                  ).then((done) => {
                    if (done) {
                      setPending(null);
                      showToast('Owner changed.');
                    }
                  });
                }}
              >
                Change owner
              </Button>
            </div>
          </div>
        </Dialog>
      )}
      {pending?.kind === 'delete' && (
        <Dialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Delete dashboard"
          description={`Deletes ${dashboard.name} and its widgets for everyone who can see it. The issues it measures stay as they are.`}
          size="sm"
        >
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Delete dashboard
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default DashboardDetail;
