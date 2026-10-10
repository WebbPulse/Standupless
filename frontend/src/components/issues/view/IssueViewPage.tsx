/**
 * An issue list or board as a page: the shell, the filter bar, the display
 * menu, the saved view controls and the view itself. The filters and display
 * live in the URL on top of a base, the page's defaults or a saved view's
 * own settings, so a link reproduces what is on screen and the saved view
 * controls know whether anything changed.
 *
 * Composing a view is this same page: a new view opens it over every team
 * with the save bar showing, and a saved view opens it over its own settings,
 * so the list updates live as the filters change and the save bar offers to
 * keep, fork or discard the change. Any other list can be saved as a view.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import {
  LuBookmarkPlus,
  LuChartBar,
  LuLayers,
  LuPencil,
  LuPlus,
  LuStar,
} from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { IssueListFilters } from '../../../api/issues';
import {
  VIEW_COLORS,
  createView,
  listViews,
  setViewFavorite,
  updateView,
  type SavedViewDisplayRead,
  type SavedViewLook,
  type ViewColor,
} from '../../../api/views';
import { useAuth } from '../../../hooks/useAuth';
import { useCreateIssue } from '../../../hooks/useCreateIssue';
import { useIssueCollection } from '../../../hooks/useIssueCollection';
import { useIssueContext } from '../../../hooks/useIssueContext';
import { useShortcut } from '../../../hooks/useShortcuts';
import { useWorkspace } from '../../../hooks/useWorkspace';
import { cn } from '../../../lib/cn';
import { errorMessage } from '../../../lib/errors';
import { insightsFilters, narrowTo } from '../../../lib/insights';
import {
  FILTER_FIELDS,
  fieldsFor,
  parseViewState,
  sameViewState,
  stateToViewBody,
  stateToViewDisplay,
  stateToViewFilter,
  viewStateQuery,
  writeViewState,
  type FilterField,
  type ViewState,
} from '../../../lib/issueView';
import { viewPath, viewsPath } from '../../../lib/paths';
import ShareButton from '../../access/ShareButton';
import ExportCsvButton from '../export/ExportCsvButton';
import { viewKey, viewsKey } from '../../../lib/queryKeys';
import { showErrorToast, showToast } from '../../../lib/toast';
import { estimateOptionsOf } from '../../../lib/validation';
import type { TeamRead } from '../../../types/Api';
import Button, { IconButton } from '../../ui/button';
import Dialog from '../../ui/dialog';
import { Input, Textarea } from '../../ui/input';
import { Menu, MenuItem, MenuLabel } from '../../ui/menu';
import { Popover } from '../../ui/popover';
import { Select } from '../../ui/select';
import ViewIcon, {
  VIEW_COLOR_HEX,
  VIEW_ICON_NAMES,
} from '../../views/ViewIcon';
import WorkspaceShell from '../../workspace/WorkspaceShell';
import DisplayMenu from './DisplayMenu';
import { FilterButton, FilterChips } from './FilterBar';
import InsightsPanel from './InsightsPanel';
import IssueListView from './IssueListView';

/** Clears every cached views list, so each surface listing views re-reads. */
const refreshViewLists = (workspaceId: string, teamId?: string): void => {
  invalidateQueries([
    viewsKey(workspaceId, 'mine', ''),
    viewsKey(workspaceId, 'team', ''),
    viewsKey(workspaceId, 'workspace', ''),
    viewsKey(workspaceId, 'all', ''),
    ...(teamId === undefined ? [] : [viewsKey(workspaceId, 'team', teamId)]),
  ]);
};

/** The workspace, as the location a view can be filed under instead of a team. */
const WORKSPACE = '';

/** What the save dialog hands back: the view's name, look and where it is filed. */
export interface ViewDetails {
  name: string;
  look: SavedViewLook;
  /** The team the view runs over and is filed under, or undefined for the workspace. */
  teamId?: string | undefined;
  /** True for a view everyone at its location sees, false for the caller's own. */
  shared: boolean;
}

/** Props for SaveViewDialog. */
export interface SaveViewDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** The teams a view can be filed under, besides the workspace. */
  teams: TeamRead[];
  /** The location the dialog starts on. */
  initialTeamId?: string | undefined;
  initialName?: string;
  initialLook?: SavedViewLook;
  /** False for a guest, who may keep a view to themselves but not share it with the workspace. */
  canShareWorkspace?: boolean;
  /** True to edit only the name, look and description of a view that already exists. */
  detailsOnly?: boolean;
  submitLabel?: string;
  onSave: (details: ViewDetails) => Promise<void>;
}

/**
 * Names a view, picks its icon and color, describes it, and files it under the
 * workspace or a team, kept to the caller or shared with everyone there.
 */
export const SaveViewDialog: React.FC<SaveViewDialogProps> = ({
  open,
  onClose,
  title = 'Save view',
  teams,
  initialTeamId,
  initialName = '',
  initialLook = {},
  canShareWorkspace = true,
  detailsOnly = false,
  submitLabel = 'Save view',
  onSave,
}) => {
  const [name, setName] = useState(initialName);
  const [icon, setIcon] = useState(initialLook.icon ?? 'layers');
  const [color, setColor] = useState<ViewColor | null>(
    initialLook.color ?? null
  );
  const [description, setDescription] = useState(initialLook.description ?? '');
  const [location, setLocation] = useState(initialTeamId ?? WORKSPACE);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const locationName =
    location === WORKSPACE
      ? 'the workspace'
      : (teams.find((team) => team.id === location)?.name ?? 'the team');
  const sharable = location !== WORKSPACE || canShareWorkspace;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description="Saves these filters and display options as a view you can return to."
      size="md"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === '' || busy) return;
          setBusy(true);
          const note = description.trim();
          void onSave({
            name: trimmed,
            look: {
              icon,
              color,
              description: note === '' ? null : note,
            },
            teamId: location === WORKSPACE ? undefined : location,
            shared: sharable && shared,
          }).finally(() => {
            setBusy(false);
          });
        }}
      >
        <div className="flex items-center gap-2">
          <Popover
            label="View icon"
            contentClassName="w-64 p-2"
            trigger={(props) => (
              <button
                type="button"
                {...props}
                aria-label="View icon and color"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-line-strong hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent"
              >
                <ViewIcon icon={icon} color={color} className="h-4 w-4" />
              </button>
            )}
          >
            <div
              className="grid grid-cols-7 gap-1"
              role="group"
              aria-label="Icon"
            >
              {VIEW_ICON_NAMES.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={item}
                  aria-pressed={item === icon}
                  onClick={() => {
                    setIcon(item);
                  }}
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-sm hover:bg-raised',
                    item === icon && 'bg-raised ring-1 ring-accent'
                  )}
                >
                  <ViewIcon icon={item} color={color} className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
            <div
              className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2"
              role="group"
              aria-label="Color"
            >
              {VIEW_COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-label={item}
                  aria-pressed={item === color}
                  onClick={() => {
                    setColor(item === color ? null : item);
                  }}
                  className={cn(
                    'h-5 w-5 rounded-full ring-offset-1 ring-offset-overlay transition-transform duration-100 hover:scale-110',
                    item === color && 'ring-2 ring-accent'
                  )}
                  style={{ backgroundColor: VIEW_COLOR_HEX[item] }}
                />
              ))}
            </div>
          </Popover>
          <Input
            aria-label="View name"
            placeholder="View name"
            autoFocus
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </div>
        <Textarea
          aria-label="Description"
          placeholder="Description (optional)"
          maxLength={500}
          className="min-h-16"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
        {!detailsOnly && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <Select
              aria-label="Location"
              value={location}
              className="w-auto"
              onChange={(event) => {
                setLocation(event.target.value);
              }}
            >
              <option value={WORKSPACE}>Workspace</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Visibility"
              value={sharable && shared ? 'shared' : 'personal'}
              className="w-auto"
              disabled={!sharable}
              onChange={(event) => {
                setShared(event.target.value === 'shared');
              }}
            >
              <option value="personal">Only me</option>
              <option value="shared">{`Everyone in ${locationName}`}</option>
            </Select>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={trimmed === '' || busy}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** Props for IssueViewPage. */
export interface IssueViewPageProps {
  workspaceId: string;
  slug: string;
  title: ReactNode;
  leading?: ReactNode;
  /** Controls at the start of the toolbar, such as a team's tabs. */
  tabs?: ReactNode;
  /** Names what the rows belong to, for the read's key. */
  scopeKey: string;
  /** The fixed part of the query, such as the team. */
  scope: IssueListFilters;
  /** The teams whose issues can appear. */
  teams: TeamRead[];
  /** The settings the page opens with before the URL changes anything. */
  base: ViewState;
  /** The saved view this page runs, when it runs one. */
  view?: SavedViewDisplayRead | undefined;
  /**
   * True for a view being composed and not yet saved: the save bar shows from
   * the start and Discard leaves for the views index.
   */
  composing?: boolean;
  canEdit: boolean;
  /** The team new issues and shared views belong to, when there is one. */
  homeTeam?: TeamRead | undefined;
  emptyMessage?: string;
  /** Filter fields the scope already fixes, left out of the Filter menu. */
  hideFilterFields?: FilterField[];
  /**
   * True for an archive, which lists archived issues alone: nothing is filed
   * into it, shared or saved as a view, and the archived toggle has no say.
   */
  archive?: boolean;
}

/** Which save dialog is open: a new view, or the details of the one running. */
type Saving = 'new' | 'details' | null;

/** The page. */
export const IssueViewPage: React.FC<IssueViewPageProps> = ({
  workspaceId,
  slug,
  title,
  leading,
  tabs,
  scopeKey,
  scope,
  teams,
  base,
  view,
  composing = false,
  canEdit,
  homeTeam,
  emptyMessage,
  hideFilterFields,
  archive = false,
}) => {
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { workspace } = useWorkspace();
  const creator = useCreateIssue();
  const [params, setParams] = useSearchParams();
  const [saving, setSaving] = useState<Saving>(null);
  const [updating, setUpdating] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [favorite, setFavorite] = useState(view?.favorite === true);

  const state = useMemo(() => parseViewState(params, base), [params, base]);
  const setState = useCallback(
    (next: ViewState) => {
      setParams(writeViewState(next, base, params), { replace: true });
    },
    [setParams, base, params]
  );
  const changed = !sameViewState(state, base);

  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const collection = useIssueCollection(
    workspaceId,
    scopeKey,
    viewStateQuery(state, scope),
    workspaceId !== '' && teamIds.length > 0
  );
  const lists = useIssueContext(workspaceId, teamIds, user?.id);
  const filterContext = useMemo(
    () => ({
      ...lists.context,
      teams: teams.map((team) => ({
        id: team.id,
        name: team.name,
        key: team.key_prefix,
      })),
    }),
    [lists.context, teams]
  );
  const filterFields = useMemo(
    () =>
      hideFilterFields === undefined
        ? undefined
        : fieldsFor(FILTER_FIELDS, filterContext).filter(
            (field) => !hideFilterFields.includes(field)
          ),
    [hideFilterFields, filterContext]
  );
  const panelFilters = useMemo(
    () => insightsFilters(state, scope),
    [state, scope]
  );

  const scaleFor = useCallback(
    (teamId: string) =>
      teams.find((team) => team.id === teamId)?.estimate_scale ?? 'off',
    [teams]
  );
  const estimateOptionsFor = useCallback(
    (teamId: string) =>
      estimateOptionsOf(teams.find((team) => team.id === teamId)),
    [teams]
  );
  const teamNameFor = useCallback(
    (teamId: string) => teams.find((team) => team.id === teamId)?.name,
    [teams]
  );

  const menuTeamId = homeTeam?.id ?? '';
  const { data: teamViews } = usePolledQuery(
    ({ signal }) =>
      listViews(workspaceId, { scope: 'all', team_id: menuTeamId }, signal),
    {
      intervalMs: 120000,
      enabled: workspaceId !== '' && menuTeamId !== '' && view === undefined,
      queryKey: viewsKey(workspaceId, 'all', menuTeamId),
      auth,
    }
  );

  const saveNew = async (details: ViewDetails): Promise<void> => {
    const teamId = details.teamId;
    const runsOver =
      teamId === undefined || typeof scope.team_id === 'string'
        ? scope
        : { ...scope, team_id: teamId };
    try {
      const created = await createView(
        workspaceId,
        stateToViewBody(
          state,
          details.name,
          runsOver,
          details.shared ? teamId : undefined,
          { shared: details.shared, look: details.look }
        )
      );
      refreshViewLists(workspaceId, teamId);
      setSaving(null);
      showToast(`Saved view ${created.name}.`);
      void navigate(viewPath(slug, created.view_id));
    } catch (error) {
      showErrorToast(errorMessage(error, 'Could not save the view.'));
    }
  };

  const saveDetails = async (details: ViewDetails): Promise<void> => {
    if (view === undefined) return;
    try {
      await updateView(workspaceId, view.view_id, {
        name: details.name,
        ...details.look,
      });
      invalidateQueries(viewKey(workspaceId, view.view_id));
      refreshViewLists(workspaceId, view.team_id ?? undefined);
      setSaving(null);
      showToast('View updated.');
    } catch (error) {
      showErrorToast(errorMessage(error, 'Could not update the view.'));
    }
  };

  const saveOver = async (): Promise<void> => {
    if (view === undefined) return;
    setUpdating(true);
    try {
      await updateView(workspaceId, view.view_id, {
        filter: stateToViewFilter(state, scope),
        ...stateToViewDisplay(state),
      });
      invalidateQueries(viewKey(workspaceId, view.view_id));
      refreshViewLists(workspaceId, view.team_id ?? undefined);
      showToast('View updated.');
    } catch (error) {
      showErrorToast(errorMessage(error, 'Could not update the view.'));
    } finally {
      setUpdating(false);
    }
  };

  const toggleFavorite = async (): Promise<void> => {
    if (view === undefined) return;
    const next = !favorite;
    setFavorite(next);
    try {
      await setViewFavorite(workspaceId, view.view_id, next);
      refreshViewLists(workspaceId, view.team_id ?? undefined);
    } catch (error) {
      setFavorite(!next);
      showErrorToast(errorMessage(error, 'Could not change the favorite.'));
    }
  };

  const reset = (): void => {
    setParams(writeViewState(base, base, params), { replace: true });
  };

  const discard = (): void => {
    if (composing) {
      void navigate(viewsPath(slug));
      return;
    }
    reset();
  };

  useShortcut({
    keys: 'shift+v',
    label: 'Save as view',
    scope: 'page',
    group: 'View',
    enabled: !archive && saving === null,
    handler: () => {
      setSaving('new');
    },
  });
  useShortcut({
    keys: 'mod+s',
    label: 'Save view changes',
    scope: 'page',
    group: 'View',
    enabled: view !== undefined && changed && !updating && saving === null,
    handler: (event) => {
      event?.preventDefault();
      void saveOver();
    },
  });

  const viewControls =
    archive || view !== undefined || composing ? null : (
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
    );

  const saveBar =
    archive || !(composing || (view !== undefined && changed)) ? null : (
      <div
        role="region"
        aria-label="Unsaved view changes"
        className="flex w-full flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
        />
        <span className="text-text-muted">
          {composing ? 'New view, not saved yet' : 'Unsaved changes'}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={discard}>
          Discard
        </Button>
        {view !== undefined && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSaving('new');
            }}
          >
            Save as new
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={updating}
          onClick={() => {
            if (view === undefined) setSaving('new');
            else void saveOver();
          }}
        >
          Save
        </Button>
      </div>
    );

  const viewsMenu =
    !archive && view === undefined && (teamViews ?? []).length > 0 ? (
      <Menu
        label="Views"
        align="end"
        trigger={(props) => (
          <Button {...props} size="sm" variant="ghost" className="gap-1.5">
            <LuLayers aria-hidden="true" className="h-3.5 w-3.5" />
            Views
          </Button>
        )}
      >
        <MenuLabel>Saved views</MenuLabel>
        {(teamViews ?? []).map((item) => (
          <MenuItem key={item.view_id} to={viewPath(slug, item.view_id)}>
            {item.name}
          </MenuItem>
        ))}
      </Menu>
    ) : null;

  const toolbar = (
    <div className="flex w-full flex-col gap-2">
      <div className="flex w-full flex-wrap items-center gap-2">
        {tabs}
        <FilterButton
          filters={state.filters}
          context={filterContext}
          {...(filterFields === undefined ? {} : { fields: filterFields })}
          onChange={(filters) => {
            setState({ ...state, filters });
          }}
        />
        <span className="flex-1" />
        {viewControls}
        {viewsMenu}
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          aria-pressed={insightsOpen}
          onClick={() => {
            setInsightsOpen((open) => !open);
          }}
        >
          <LuChartBar aria-hidden="true" className="h-3.5 w-3.5" />
          Insights
        </Button>
        <DisplayMenu
          state={state}
          onChange={setState}
          archive={archive}
          onReset={
            sameViewState({ ...state, filters: base.filters, q: base.q }, base)
              ? undefined
              : () => {
                  setState({ ...base, filters: state.filters, q: state.q });
                }
          }
        />
      </div>
      <FilterChips
        filters={state.filters}
        context={filterContext}
        onChange={(filters) => {
          setState({ ...state, filters });
        }}
      />
      {saveBar}
    </div>
  );

  const scopedTeamId = scope.team_id;
  const share =
    !canEdit || archive ? null : view !== undefined ? (
      view.team_id ? (
        <ShareButton
          workspaceId={workspaceId}
          targetType="view"
          targetId={view.view_id}
        />
      ) : null
    ) : typeof scopedTeamId === 'string' && scopedTeamId !== '' ? (
      <ShareButton
        workspaceId={workspaceId}
        targetType="filter"
        targetId={scopedTeamId}
        snapshot={{
          filter: stateToViewFilter(state, scope),
          sort: state.ordering,
        }}
      />
    ) : null;

  const newIssue =
    canEdit && !archive && creator.canCreate ? (
      <Button
        size="sm"
        variant="primary"
        className="gap-1.5"
        onClick={() => {
          creator.open({
            ...(homeTeam === undefined ? {} : { teamId: homeTeam.id }),
            onCreated: () => {
              invalidateQueries(collection.queryKey);
            },
          });
        }}
      >
        <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
        New issue
      </Button>
    ) : null;

  const exportCsv = (
    <ExportCsvButton
      workspaceId={workspaceId}
      filters={viewStateQuery(state, scope)}
      name={view?.name ?? homeTeam?.name ?? scopeKey}
    />
  );

  const viewActions =
    view === undefined ? null : (
      <>
        <IconButton
          label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          size="sm"
          aria-pressed={favorite}
          onClick={() => void toggleFavorite()}
        >
          <LuStar
            aria-hidden="true"
            className={cn(
              'h-3.5 w-3.5',
              favorite && 'fill-current text-warning'
            )}
          />
        </IconButton>
        <IconButton
          label="Edit view details"
          size="sm"
          onClick={() => {
            setSaving('details');
          }}
        >
          <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
        </IconButton>
      </>
    );

  const actions = (
    <div className="flex items-center gap-1.5">
      {viewActions}
      {exportCsv}
      {share}
      {newIssue}
    </div>
  );

  return (
    <WorkspaceShell
      title={title}
      leading={leading}
      actions={actions}
      toolbar={toolbar}
      flush
    >
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <IssueListView
            slug={slug}
            state={state}
            onStateChange={setState}
            collection={collection}
            lists={lists}
            scaleFor={scaleFor}
            estimateOptionsFor={estimateOptionsFor}
            {...(teams.length > 1 ? { teamNameFor } : {})}
            canEdit={canEdit}
            createTeamId={homeTeam?.id}
            collapseKey={`${workspaceId}.${view?.view_id ?? scopeKey}`}
            {...(emptyMessage === undefined ? {} : { emptyMessage })}
            filterFields={filterFields}
          />
        </div>
        {insightsOpen && (
          <InsightsPanel
            workspaceId={workspaceId}
            scopeKey={scopeKey}
            filters={panelFilters}
            onPick={(field, value) => {
              setState({
                ...state,
                filters: narrowTo(state.filters, field, value),
              });
            }}
            onClose={() => {
              setInsightsOpen(false);
            }}
            className="max-h-[45%] border-t border-line lg:max-h-none lg:w-80 lg:shrink-0 lg:border-t-0 lg:border-l xl:w-96"
          />
        )}
      </div>
      {saving === 'new' && (
        <SaveViewDialog
          open
          onClose={() => {
            setSaving(null);
          }}
          title={view === undefined ? 'Save view' : 'Save as new view'}
          teams={teams}
          initialTeamId={homeTeam?.id}
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

export default IssueViewPage;
