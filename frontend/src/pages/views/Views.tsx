/**
 * Every saved view the caller can open, as a dense list: each row shows the
 * view's icon, name, owner, where it is filed and how many issues it selects,
 * with rename, duplicate, favorite and delete one menu away. New view opens
 * the composer, which is the issue list itself, so there is no form to fill
 * before seeing what a view would show.
 */

import React, { useMemo, useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuCopy,
  LuEllipsis,
  LuLayers,
  LuPencil,
  LuPlus,
  LuStar,
  LuTrash2,
} from 'react-icons/lu';
import { Link, useNavigate } from 'react-router-dom';
import { getInsights } from '../../api/insights';
import {
  createView,
  deleteView,
  listViews,
  setViewFavorite,
  updateView,
  type SavedViewDisplayRead,
} from '../../api/views';
import { SaveViewDialog } from '../../components/issues/view/IssueViewPage';
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
import ViewIcon from '../../components/views/ViewIcon';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { errorMessage } from '../../lib/errors';
import { newViewPath, viewPath } from '../../lib/paths';
import { viewCountKey, viewKey, viewsKey } from '../../lib/queryKeys';
import { showErrorToast, showToast } from '../../lib/toast';
import type { ViewListScope } from '../../types/Api';

/** How often the view list is re-read while the page is open. */
const POLL_MS = 60000;

/** How often a row's issue count is re-read. */
const COUNT_POLL_MS = 300000;

/** The scopes the list route takes, with their interface wording. */
const SCOPES: { value: ViewListScope; label: string }[] = [
  { value: 'all', label: 'All views' },
  { value: 'mine', label: 'My views' },
  { value: 'team', label: 'Team views' },
  { value: 'workspace', label: 'Workspace views' },
];

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

/** The saved views list. */
export const Views: React.FC = () => {
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const [scope, setScope] = useState<ViewListScope>('all');
  const [pending, setPending] = useState<Pending>(null);
  const [deleting, setDeleting] = useState(false);
  const workspaceId = workspace?.id ?? '';
  const slug = workspace?.slug ?? '';
  const members = useWorkspaceMembers(workspaceId);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listViews(workspaceId, { scope }, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: viewsKey(workspaceId, scope, ''),
      auth,
    }
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
      const copy = await createView(workspaceId, {
        name: `${view.name} copy`,
        kind: view.kind,
        filter: view.filter,
        sort: view.sort,
        group_by: view.group_by,
        sub_group_by: view.sub_group_by,
        ordering: view.ordering,
        visible_properties: view.visible_properties,
        layout: view.layout,
        show_sub_issues: view.show_sub_issues,
        show_completed: view.show_completed,
        ...(view.show_archived === undefined
          ? {}
          : { show_archived: view.show_archived }),
        icon: view.icon ?? null,
        color: view.color ?? null,
        description: view.description ?? null,
      });
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
    } catch (failure) {
      showErrorToast(errorMessage(failure, 'Could not change the favorite.'));
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

  return (
    <WorkspaceShell
      title="Views"
      actions={
        <Button
          size="sm"
          variant="primary"
          className="gap-1.5"
          onClick={() => {
            void navigate(newViewPath(slug));
          }}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          New view
        </Button>
      }
      toolbar={
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
      }
      flush
    >
      {error !== null && (
        <div className="px-4 pt-3 lg:px-6">
          <ErrorAlert message={errorMessage(error, 'Could not load views.')} />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading || data === null ? (
          <SkeletonRows />
        ) : data.length === 0 ? (
          <EmptyState
            icon={<LuLayers />}
            message="No saved views yet. Compose one with New view, or save any issue list as a view."
            className="py-16"
          />
        ) : (
          <ul aria-label="Saved views">
            {data.map((view) => {
              const owner = memberNames.get(view.owner_id);
              return (
                <li
                  key={view.view_id}
                  className="group flex h-row items-center gap-3 border-b border-line px-4 text-sm transition-colors duration-100 hover:bg-surface lg:px-6"
                >
                  <Link
                    to={viewPath(slug, view.view_id)}
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
                  <ViewCount workspaceId={workspaceId} view={view} />
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
                      <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
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
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={() => {
                        setPending({ kind: 'delete', view });
                      }}
                    >
                      <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      Delete
                    </MenuItem>
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {pending?.kind === 'rename' && (
        <SaveViewDialog
          open
          onClose={() => {
            setPending(null);
          }}
          title="Edit view"
          teams={teams}
          detailsOnly
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
