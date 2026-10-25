/**
 * The dashboards tab of the views page: the caller's personal dashboards
 * under their own heading, then the ones shared with a team or the workspace.
 * Under a team's route only that team's dashboards and the caller's own are
 * listed. Each row opens the dashboard, with edit and delete one menu away,
 * and J, K and Enter move through both headings' rows as one list.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuEllipsis,
  LuLayoutDashboard,
  LuPencil,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import {
  createDashboard,
  deleteDashboard,
  listDashboards,
} from '../../api/dashboards';
import DashboardDialog from '../../components/dashboards/DashboardDialog';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Badge from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { Menu, MenuItem, MenuSeparator } from '../../components/ui/menu';
import { SkeletonRows } from '../../components/ui/skeleton';
import { useListKeyboardNav } from '../../hooks/useListKeyboardNav';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { cn } from '../../lib/cn';
import {
  dashboardLocation,
  refreshDashboards,
  saveDashboardDetails,
  type DashboardDetails,
} from '../../lib/dashboards';
import { errorMessage } from '../../lib/errors';
import { dashboardPath } from '../../lib/paths';
import { LOOKUP_POLL_MS } from '../../lib/polling';
import { dashboardsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { DashboardRead, TeamRead } from '../../types/Api';

/** Props for DashboardList. */
export interface DashboardListProps {
  workspaceId: string;
  slug: string;
  /** The team in the route, or empty across the workspace. */
  teamId: string;
  teams: TeamRead[];
  canShareWorkspace: boolean;
  creating: boolean;
  onCreated: () => void;
}

/** Which dialog is open over the list, and for which dashboard. */
type Pending =
  | { kind: 'edit'; dashboard: DashboardRead }
  | { kind: 'delete'; dashboard: DashboardRead }
  | null;

/** The dashboards list. */
export const DashboardList: React.FC<DashboardListProps> = ({
  workspaceId,
  slug,
  teamId,
  teams,
  canShareWorkspace,
  creating,
  onCreated,
}) => {
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const members = useWorkspaceMembers(workspaceId);
  const [pending, setPending] = useState<Pending>(null);
  const [deleting, setDeleting] = useState(false);
  const scoped = teamId !== '';
  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listDashboards(workspaceId, scoped ? { team_id: teamId } : {}, signal),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: dashboardsKey(workspaceId, 'all', teamId),
      auth,
    }
  );
  const members_ = useMemo(
    () => new Map(members.map((member) => [member.user_id, member])),
    [members]
  );
  const sections = useMemo(() => {
    const rows = data ?? [];
    return [
      {
        heading: 'Personal',
        rows: rows.filter((row) => row.scope === 'personal'),
      },
      {
        heading: scoped ? 'Team' : 'Shared',
        rows: rows.filter((row) => row.scope !== 'personal'),
      },
    ].filter((section) => section.rows.length > 0);
  }, [data, scoped]);

  const ordered = useMemo(
    () => sections.flatMap((section) => section.rows),
    [sections]
  );
  const positions = useMemo(
    () => new Map(ordered.map((dashboard, index) => [dashboard.id, index])),
    [ordered]
  );
  const onActivate = useCallback(
    (index: number) => {
      const dashboard = ordered[index];
      if (dashboard !== undefined)
        void navigate(dashboardPath(slug, dashboard.id));
    },
    [ordered, navigate, slug]
  );
  const { activeIndex, setActiveIndex, registerItem } = useListKeyboardNav({
    count: ordered.length,
    onActivate,
    resetKey: `${teamId}:${ordered.map((dashboard) => dashboard.id).join(',')}`,
    enabled: pending === null && !creating,
  });

  const create = async (details: DashboardDetails): Promise<void> => {
    try {
      const created = await createDashboard(workspaceId, {
        name: details.name,
        description: details.description,
        scope: details.scope,
        team_id: details.teamId,
      });
      refreshDashboards(workspaceId, teamId);
      onCreated();
      void navigate(dashboardPath(slug, created.id));
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not create the dashboard.'));
    }
  };

  const edit = async (
    dashboard: DashboardRead,
    details: DashboardDetails
  ): Promise<void> => {
    try {
      await saveDashboardDetails(workspaceId, dashboard, details);
      refreshDashboards(workspaceId, teamId, dashboard.id);
      setPending(null);
      showToast('Dashboard updated.');
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not update the dashboard.'));
    }
  };

  const remove = async (dashboard: DashboardRead): Promise<void> => {
    setDeleting(true);
    try {
      await deleteDashboard(workspaceId, dashboard.id);
      refreshDashboards(workspaceId, teamId);
      setPending(null);
      showToast(`Deleted ${dashboard.name}.`);
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not delete the dashboard.'));
    } finally {
      setDeleting(false);
    }
  };

  const initialTeam = scoped ? teamId : null;

  return (
    <>
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert
            message={errorMessage(error, 'Could not load dashboards.')}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading || data === null ? (
          <SkeletonRows />
        ) : sections.length === 0 ? (
          <EmptyState
            icon={<LuLayoutDashboard />}
            message={
              scoped
                ? 'No dashboards for this team yet. A dashboard puts insights from several teams and views on one page.'
                : 'No dashboards yet. A dashboard puts insights from several teams and views on one page.'
            }
            className="py-16"
          />
        ) : (
          sections.map((section) => (
            <section key={section.heading} aria-label={section.heading}>
              <h2 className="border-b border-line bg-bg px-4 py-1.5 text-xs font-medium text-text-muted lg:px-6">
                {section.heading}
              </h2>
              <ul aria-label={`${section.heading} dashboards`}>
                {section.rows.map((dashboard) => {
                  const owner = members_.get(dashboard.owner_id);
                  const ownerName = owner?.display_name ?? owner?.email;
                  const position = positions.get(dashboard.id) ?? -1;
                  const isActive = position === activeIndex;
                  return (
                    <li
                      key={dashboard.id}
                      ref={registerItem(position)}
                      aria-current={isActive ? 'true' : undefined}
                      onPointerEnter={() => {
                        setActiveIndex(position);
                      }}
                      className={cn(
                        'group relative flex h-row items-center gap-3 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface lg:px-6',
                        isActive &&
                          'bg-surface before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent'
                      )}
                    >
                      <Link
                        to={dashboardPath(slug, dashboard.id)}
                        data-hover="parent"
                        className="flex min-w-0 flex-1 items-center gap-3 focus-visible:underline focus-visible:outline-none"
                      >
                        <LuLayoutDashboard
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0 text-text-muted"
                        />
                        <span className="truncate font-medium text-text">
                          {dashboard.name}
                        </span>
                        {dashboard.description !== null && (
                          <span className="hidden min-w-0 truncate text-xs text-text-faint md:inline">
                            {dashboard.description}
                          </span>
                        )}
                      </Link>
                      <Badge
                        tone="neutral"
                        className="hidden shrink-0 sm:inline-flex"
                      >
                        {dashboardLocation(dashboard, teams)}
                      </Badge>
                      <span className="hidden w-36 shrink-0 items-center gap-1.5 truncate text-xs text-text-muted md:flex">
                        {ownerName !== undefined && (
                          <>
                            <Avatar
                              name={ownerName}
                              src={owner?.avatar_url}
                              size="xs"
                            />
                            <span className="truncate">{ownerName}</span>
                          </>
                        )}
                      </span>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-text-faint">
                        {dashboard.widgets.length}
                      </span>
                      {dashboard.can_edit ? (
                        <Menu
                          label={`Actions for ${dashboard.name}`}
                          align="end"
                          trigger={(props) => (
                            <IconButton
                              {...props}
                              label={`Actions for ${dashboard.name}`}
                              size="sm"
                              className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              <LuEllipsis
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                              />
                            </IconButton>
                          )}
                        >
                          <MenuItem
                            onSelect={() => {
                              setPending({ kind: 'edit', dashboard });
                            }}
                          >
                            <LuPencil
                              aria-hidden="true"
                              className="h-3.5 w-3.5"
                            />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            danger
                            onSelect={() => {
                              setPending({ kind: 'delete', dashboard });
                            }}
                          >
                            <LuTrash2
                              aria-hidden="true"
                              className="h-3.5 w-3.5"
                            />
                            Delete
                          </MenuItem>
                        </Menu>
                      ) : (
                        <span className="w-7 shrink-0" />
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      {creating && (
        <DashboardDialog
          title="New dashboard"
          submitLabel="Create dashboard"
          teams={teams}
          canShareWorkspace={canShareWorkspace}
          initial={
            initialTeam === null ? {} : { scope: 'team', teamId: initialTeam }
          }
          onClose={onCreated}
          onSave={create}
        />
      )}
      {pending?.kind === 'edit' && (
        <DashboardDialog
          title="Edit dashboard"
          submitLabel="Save changes"
          teams={teams}
          canShareWorkspace={canShareWorkspace}
          initial={{
            name: pending.dashboard.name,
            description: pending.dashboard.description,
            scope: pending.dashboard.scope,
            teamId: pending.dashboard.team_id,
          }}
          onClose={() => {
            setPending(null);
          }}
          onSave={(details) => edit(pending.dashboard, details)}
        />
      )}
      {pending?.kind === 'delete' && (
        <Dialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Delete dashboard"
          description={`Deletes ${pending.dashboard.name} and its widgets for everyone who can see it. The issues it measures stay as they are.`}
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
              disabled={deleting}
              onClick={() => void remove(pending.dashboard)}
            >
              Delete dashboard
            </Button>
          </div>
        </Dialog>
      )}
    </>
  );
};

export default DashboardList;
