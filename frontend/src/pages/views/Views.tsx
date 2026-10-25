/**
 * Every saved view the caller can open, as a dense list: each row shows the
 * view's icon, name, owner, where it is filed and how many issues it selects,
 * with rename, duplicate, favorite, subscribe and delete one menu away. A
 * bell marks the views the caller follows. New view opens
 * the composer, which is the issue list itself, so there is no form to fill
 * before seeing what a view would show. Views of issues and views of
 * projects sit under their own tabs; New view on the projects tab opens the
 * projects page, which saves its arrangement as a view. Under a team's route
 * the list narrows to the views shared with that team. A third tab lists the
 * dashboards, which put insights from several teams and views on one page.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuBell,
  LuBellOff,
  LuCopy,
  LuEllipsis,
  LuLayers,
  LuPencil,
  LuPlus,
  LuStar,
  LuTrash2,
} from 'react-icons/lu';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { getInsights } from '../../api/insights';
import {
  createView,
  deleteView,
  listViews,
  listsProjects,
  setViewFavorite,
  setViewSubscription,
  updateView,
  type SavedViewDisplayCreate,
  type SavedViewDisplayRead,
  type ViewEntity,
} from '../../api/views';
import { SaveViewDialog } from '../../components/issues/view/IssueViewPage';
import { SubscriberCount } from '../../components/issues/view/ViewSubscribeButton';
import type { ViewDetails } from '../../components/issues/view/IssueViewPage';
import { ErrorAlert } from '../../components/ui/alert';
import Avatar from '../../components/ui/avatar';
import Badge from '../../components/ui/badge';
import Button, { IconButton } from '../../components/ui/button';
import Dialog from '../../components/ui/dialog';
import EmptyState from '../../components/ui/empty-state';
import { Menu, MenuItem, MenuSeparator } from '../../components/ui/menu';
import { Select } from '../../components/ui/select';
import { SkeletonRows } from '../../components/ui/skeleton';
import DashboardList from './DashboardList';
import ViewIcon from '../../components/views/ViewIcon';
import TeamTitle from '../../components/workspace/TeamTitle';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useAuth } from '../../hooks/useAuth';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { sharedChange, viewVisibility } from '../../lib/issueView';
import {
  newViewPath,
  projectsPath,
  teamProjectsPath,
  viewPath,
} from '../../lib/paths';
import {
  favoritesKey,
  viewCountKey,
  viewKey,
  viewsKey,
} from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { ViewListScope } from '../../types/Api';
import { LOOKUP_POLL_MS } from '../../lib/polling';

/** How often a row's issue count is re-read. */
const COUNT_POLL_MS = 300000;

/** The scopes the list route takes, with their interface wording. */
const SCOPES: { value: ViewListScope; label: string }[] = [
  { value: 'all', label: 'All views' },
  { value: 'mine', label: 'My views' },
  { value: 'team', label: 'Team views' },
  { value: 'workspace', label: 'Workspace views' },
];

/** A tab of the page: the views of one entity, or the dashboards. */
type ViewsTab = ViewEntity | 'dashboards';

/** The page's tabs, with their wording. */
const ENTITIES: { value: ViewsTab; label: string }[] = [
  { value: 'issues', label: 'Issues' },
  { value: 'projects', label: 'Projects' },
  { value: 'dashboards', label: 'Dashboards' },
];

/** The body that copies a view, its filter and whichever display it keeps. */
const copyOf = (view: SavedViewDisplayRead): SavedViewDisplayCreate => {
  const look = {
    icon: view.icon ?? null,
    color: view.color ?? null,
    description: view.description ?? null,
  };
  if (listsProjects(view)) {
    return {
      name: `${view.name} copy`,
      kind: view.kind,
      entity: 'projects',
      filter: view.filter,
      ...(view.projects_display == null
        ? {}
        : { projects_display: view.projects_display }),
      ...look,
    };
  }
  return {
    name: `${view.name} copy`,
    kind: view.kind,
    filter: view.filter,
    sort: view.sort,
    group_by: view.group_by,
    sub_group_by: view.sub_group_by,
    ordering: view.ordering,
    ...(view.ordering_reversed === true ? { ordering_reversed: true } : {}),
    visible_properties: view.visible_properties,
    layout: view.layout,
    show_sub_issues: view.show_sub_issues,
    show_completed: view.show_completed,
    ...(view.completed_window === undefined
      ? {}
      : { completed_window: view.completed_window }),
    ...(view.show_archived === undefined
      ? {}
      : { show_archived: view.show_archived }),
    ...(view.group_header === undefined
      ? {}
      : { group_header: view.group_header }),
    ...look,
  };
};

/** Clears every cached views list, so the sidebar and this page re-read. */
const refreshViewLists = (
  workspaceId: string,
  view: SavedViewDisplayRead
): void => {
  invalidateQueries([
    ...SCOPES.map((scope) => viewsKey(workspaceId, scope.value, '')),
    ...(view.team_id === null
      ? []
      : [viewsKey(workspaceId, 'team', view.team_id)]),
    ...(view.team_id === null
      ? []
      : [viewsKey(workspaceId, 'all', view.team_id)]),
    viewKey(workspaceId, view.view_id),
  ]);
};

/** The number of issues a view selects, counted by the server. */
const ViewCount: React.FC<{
  workspaceId: string;
  view: SavedViewDisplayRead;
}> = ({ workspaceId, view }) => {
  const auth = useQueryAuth();
  const { data } = usePolledQuery(
    ({ signal }) =>
      getInsights(
        workspaceId,
        { group_by: 'status_category', view_id: view.view_id },
        signal
      ),
    {
      intervalMs: COUNT_POLL_MS,
      enabled: workspaceId !== '',
      queryKey: viewCountKey(workspaceId, view.view_id, view.updated_at),
      auth,
    }
  );
  const count = data?.issue_count;
  return (
    <span
      className="w-16 shrink-0 text-right text-xs tabular-nums text-text-faint"
      title={count === undefined ? undefined : `${count} issues`}
    >
      {count === undefined ? '' : count}
    </span>
  );
};

/** Which dialog is open over the list, and for which view. */
type Pending =
  | { kind: 'rename'; view: SavedViewDisplayRead }
  | { kind: 'delete'; view: SavedViewDisplayRead }
  | null;

/** The saved views list, across the workspace or for the team in the route. */
export const Views: React.FC = () => {
  const { keyPrefix } = useParams<{ keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const { user } = useAuth();
  const { team, teams, notFound } = useTeam(keyPrefix);
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const [scope, setScope] = useState<ViewListScope>('all');
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<ViewsTab>(
    searchParams.get('tab') === 'dashboards' ? 'dashboards' : 'issues'
  );
  const [creatingDashboard, setCreatingDashboard] = useState(false);
  const dashboards = tab === 'dashboards';
  const entity: ViewEntity = tab === 'projects' ? 'projects' : 'issues';
  const [pending, setPending] = useState<Pending>(null);
  const [deleting, setDeleting] = useState(false);
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const members = useWorkspaceMembers(workspaceId);
  const teamId = team?.id ?? '';
  const scoped = keyPrefix !== undefined;

  const { data, error, isLoading } = usePolledQuery(
    (context) =>
      listViews(
        workspaceId,
        scoped ? { scope: 'team', team_id: teamId } : { scope },
        context
      ),
    {
      intervalMs: LOOKUP_POLL_MS,
      enabled: workspaceId !== '' && !dashboards && (!scoped || teamId !== ''),
      queryKey: scoped
        ? viewsKey(workspaceId, 'team', teamId)
        : viewsKey(workspaceId, scope, ''),
      auth,
    }
  );

  const listed = useMemo(
    () =>
      data === null
        ? null
        : data.filter(
            (view) => listsProjects(view) === (entity === 'projects')
          ),
    [data, entity]
  );

  const memberNames = useMemo(
    () =>
      new Map(
        members.map((member) => [
          member.user_id,
          {
            name: member.display_name ?? member.email,
            avatar: member.avatar_url,
          },
        ])
      ),
    [members]
  );

  const location = (view: SavedViewDisplayRead): string => {
    if (view.scope === 'workspace') return 'Workspace';
    if (view.team_id === null) return 'Personal';
    return teams.find((team) => team.id === view.team_id)?.name ?? 'Team';
  };

  const duplicate = async (view: SavedViewDisplayRead): Promise<void> => {
    try {
      const copy = await createView(workspaceId, copyOf(view));
      refreshViewLists(workspaceId, copy);
      showToast(`Duplicated as ${copy.name}.`);
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not duplicate the view.'));
    }
  };

  const toggleFavorite = async (view: SavedViewDisplayRead): Promise<void> => {
    try {
      await setViewFavorite(workspaceId, view.view_id, view.favorite !== true);
      refreshViewLists(workspaceId, view);
      invalidateQueries(favoritesKey(workspaceId));
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not change the favorite.'));
    }
  };

  const toggleSubscription = async (
    view: SavedViewDisplayRead
  ): Promise<void> => {
    const subscribing = view.subscribed !== true;
    try {
      await setViewSubscription(workspaceId, view.view_id, subscribing);
      refreshViewLists(workspaceId, view);
      showToast(
        subscribing
          ? `Subscribed to ${view.name}.`
          : `Unsubscribed from ${view.name}.`
      );
    } catch (failure) {
      showErrorToast(
        errorMessage(failure, 'Could not change the subscription.')
      );
    }
  };

  const rename = async (
    view: SavedViewDisplayRead,
    details: ViewDetails
  ): Promise<void> => {
    try {
      await updateView(workspaceId, view.view_id, {
        name: details.name,
        ...details.look,
        ...sharedChange(view, details.shared),
      });
      refreshViewLists(workspaceId, view);
      setPending(null);
      showToast('View updated.');
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not update the view.'));
    }
  };

  const remove = async (view: SavedViewDisplayRead): Promise<void> => {
    setDeleting(true);
    try {
      await deleteView(workspaceId, view.view_id);
      refreshViewLists(workspaceId, view);
      setPending(null);
      showToast(`Deleted ${view.name}.`);
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not delete the view.'));
    } finally {
      setDeleting(false);
    }
  };

  if (scoped && notFound) {
    return (
      <WorkspaceShell title="Views">
        <EmptyState message="That team does not exist, or you are not a member of it." />
      </WorkspaceShell>
    );
  }

  const newProjectsView =
    team === null
      ? projectsPath(slug)
      : teamProjectsPath(slug, team.key_prefix);

  return (
    <WorkspaceShell
      title={
        team === null ? (
          'Views'
        ) : (
          <TeamTitle name={`${team.name} views`} keyPrefix={team.key_prefix} />
        )
      }
      actions={
        <Button
          size="sm"
          variant="primary"
          className="gap-1.5"
          onClick={() => {
            if (dashboards) {
              setCreatingDashboard(true);
              return;
            }
            void navigate(
              entity === 'projects' ? newProjectsView : newViewPath(slug)
            );
          }}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          {dashboards ? 'New dashboard' : 'New view'}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="tablist"
            aria-label="What the views list"
            className="flex items-center gap-1"
          >
            {ENTITIES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={tab === option.value}
                onClick={() => {
                  setTab(option.value);
                  setSearchParams(
                    option.value === 'dashboards' ? { tab: 'dashboards' } : {},
                    { replace: true }
                  );
                }}
                className={cn(
                  'rounded-md px-2 py-1 text-sm transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                  tab === option.value
                    ? 'bg-raised text-text'
                    : 'text-text-muted hover:text-text'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {!scoped && !dashboards && (
            <Select
              aria-label="Which views"
              value={scope}
              className="h-7 w-auto text-xs"
              onChange={(event) => {
                setScope(event.target.value as ViewListScope);
              }}
            >
              {SCOPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </div>
      }
      flush
    >
      {dashboards ? (
        scoped && team === null ? (
          <SkeletonRows />
        ) : (
          <DashboardList
            workspaceId={workspaceId}
            slug={slug}
            teamId={teamId}
            teams={teams}
            canShareWorkspace={workspace?.role !== 'guest'}
            creating={creatingDashboard}
            onCreated={() => {
              setCreatingDashboard(false);
            }}
          />
        )
      ) : (
        <>
          {error !== null && (
            <div className="px-4 pt-3 lg:px-6">
              <ErrorAlert
                message={errorMessage(error, 'Could not load views.')}
              />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading || listed === null || (scoped && team === null) ? (
              <SkeletonRows />
            ) : listed.length === 0 ? (
              <EmptyState
                icon={<LuLayers />}
                message={
                  scoped
                    ? entity === 'projects'
                      ? 'No project views are shared with this team yet. Arrange its projects and save them as a team view.'
                      : 'No views are shared with this team yet. Compose one with New view and file it under this team.'
                    : entity === 'projects'
                      ? 'No saved views of projects yet. Arrange the projects page and save it as a view.'
                      : 'No saved views yet. Compose one with New view, or save any issue list as a view.'
                }
                className="py-16"
              />
            ) : (
              <ul aria-label="Saved views">
                {listed.map((view) => {
                  const owner = memberNames.get(view.owner_id);
                  return (
                    <li
                      key={view.view_id}
                      className="group flex h-row items-center gap-3 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface lg:px-6"
                    >
                      <Link
                        to={viewPath(slug, view.view_id)}
                        data-hover="parent"
                        className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none focus-visible:underline"
                      >
                        <ViewIcon
                          icon={view.icon ?? null}
                          color={view.color ?? null}
                          layout={view.layout}
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="truncate font-medium text-text">
                          {view.name}
                        </span>
                        {view.favorite === true && (
                          <LuStar
                            aria-label="Favorite"
                            className="h-3 w-3 shrink-0 fill-current text-warning"
                          />
                        )}
                        {view.subscribed === true && (
                          <LuBell
                            aria-label="Subscribed"
                            className="h-3 w-3 shrink-0 text-text-muted"
                          />
                        )}
                        {view.description !== null &&
                          view.description !== undefined && (
                            <span className="hidden min-w-0 truncate text-xs text-text-faint md:inline">
                              {view.description}
                            </span>
                          )}
                      </Link>
                      <Badge
                        tone="neutral"
                        className="hidden shrink-0 sm:inline-flex"
                      >
                        {location(view)}
                      </Badge>
                      <span className="hidden w-36 shrink-0 items-center gap-1.5 truncate text-xs text-text-muted md:flex">
                        {owner !== undefined && (
                          <>
                            <Avatar
                              name={owner.name}
                              src={owner.avatar}
                              size="xs"
                            />
                            <span className="truncate">{owner.name}</span>
                          </>
                        )}
                      </span>
                      {listsProjects(view) ? (
                        <span className="w-16 shrink-0" />
                      ) : (
                        <ViewCount workspaceId={workspaceId} view={view} />
                      )}
                      <Menu
                        label={`Actions for ${view.name}`}
                        align="end"
                        trigger={(props) => (
                          <IconButton
                            {...props}
                            label={`Actions for ${view.name}`}
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
                            setPending({ kind: 'rename', view });
                          }}
                        >
                          <LuPencil
                            aria-hidden="true"
                            className="h-3.5 w-3.5"
                          />
                          Rename
                        </MenuItem>
                        <MenuItem onSelect={() => void duplicate(view)}>
                          <LuCopy aria-hidden="true" className="h-3.5 w-3.5" />
                          Duplicate
                        </MenuItem>
                        <MenuItem onSelect={() => void toggleFavorite(view)}>
                          <LuStar aria-hidden="true" className="h-3.5 w-3.5" />
                          {view.favorite === true
                            ? 'Remove from favorites'
                            : 'Add to favorites'}
                        </MenuItem>
                        {!listsProjects(view) && (
                          <MenuItem
                            onSelect={() => void toggleSubscription(view)}
                          >
                            {view.subscribed === true ? (
                              <LuBellOff
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                              />
                            ) : (
                              <LuBell
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                              />
                            )}
                            {view.subscribed === true
                              ? 'Unsubscribe'
                              : 'Subscribe'}
                            <SubscriberCount count={view.subscriber_count} />
                          </MenuItem>
                        )}
                        <MenuSeparator />
                        <MenuItem
                          danger
                          onSelect={() => {
                            setPending({ kind: 'delete', view });
                          }}
                        >
                          <LuTrash2
                            aria-hidden="true"
                            className="h-3.5 w-3.5"
                          />
                          Delete
                        </MenuItem>
                      </Menu>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      {pending?.kind === 'rename' && (
        <SaveViewDialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Edit view"
          teams={teams}
          detailsOnly
          {...viewVisibility(pending.view, user?.id, workspace?.role)}
          submitLabel="Save changes"
          initialName={pending.view.name}
          initialLook={{
            icon: pending.view.icon ?? null,
            color: pending.view.color ?? null,
            description: pending.view.description ?? null,
          }}
          onSave={(details) => rename(pending.view, details)}
        />
      )}
      {pending?.kind === 'delete' && (
        <Dialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Delete view"
          description={`Deletes ${pending.view.name} for everyone who can see it. The issues it lists stay as they are.`}
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
              onClick={() => void remove(pending.view)}
            >
              Delete view
            </Button>
          </div>
        </Dialog>
      )}
    </WorkspaceShell>
  );
};

export default Views;
