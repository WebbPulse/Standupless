/**
 * An issue list or board as a page: the shell, the filter bar, the display
 * menu, the saved view controls and the view itself. The filters and display
 * live in the URL on top of a base, the page's defaults or a saved view's
 * own settings, so a link reproduces what is on screen and the saved view
 * controls know whether anything changed.
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { invalidateQueries, usePolledQuery } from '@webbpulse/api-client/react';
import { LuLayers, LuPlus } from 'react-icons/lu';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { IssueListFilters } from '../../../api/issues';
import {
  createView,
  listViews,
  updateView,
  type SavedViewDisplayRead,
} from '../../../api/views';
import { useAuth } from '../../../hooks/useAuth';
import { useCreateIssue } from '../../../hooks/useCreateIssue';
import { useIssueCollection } from '../../../hooks/useIssueCollection';
import { useIssueContext } from '../../../hooks/useIssueContext';
import { errorMessage } from '../../../lib/errors';
import {
  parseViewState,
  sameViewState,
  stateToViewBody,
  stateToViewDisplay,
  stateToViewFilter,
  viewStateQuery,
  writeViewState,
  type ViewState,
} from '../../../lib/issueView';
import { viewPath } from '../../../lib/paths';
import ShareButton from '../../access/ShareButton';
import { viewKey, viewsKey } from '../../../lib/queryKeys';
import { showErrorToast, showToast } from '../../../lib/toast';
import type { TeamRead } from '../../../types/Api';
import Button from '../../ui/button';
import Checkbox from '../../ui/checkbox';
import Dialog from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Menu, MenuItem, MenuLabel } from '../../ui/menu';
import WorkspaceShell from '../../workspace/WorkspaceShell';
import DisplayMenu from './DisplayMenu';
import { FilterButton, FilterChips } from './FilterBar';
import IssueListView from './IssueListView';

/** Clears every cached views list, so each surface listing views re-reads. */
const refreshViewLists = (workspaceId: string, teamId?: string): void => {
  invalidateQueries([
    viewsKey(workspaceId, 'mine', ''),
    viewsKey(workspaceId, 'team', ''),
    viewsKey(workspaceId, 'all', ''),
    ...(teamId === undefined ? [] : [viewsKey(workspaceId, 'team', teamId)]),
  ]);
};

/** Props for SaveViewDialog. */
interface SaveViewDialogProps {
  open: boolean;
  onClose: () => void;
  /** The team the view can be shared with, when there is one. */
  shareTeam?: TeamRead | undefined;
  initialName?: string;
  onSave: (name: string, share: boolean) => Promise<void>;
}

/** Names a new view and chooses whether the team sees it. */
const SaveViewDialog: React.FC<SaveViewDialogProps> = ({
  open,
  onClose,
  shareTeam,
  initialName = '',
  onSave,
}) => {
  const [name, setName] = useState(initialName);
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save view"
      description="Saves these filters and display options as a view you can return to."
      size="sm"
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === '' || busy) return;
          setBusy(true);
          void onSave(trimmed, share).finally(() => {
            setBusy(false);
          });
        }}
      >
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
        {shareTeam !== undefined && (
          <Checkbox
            label={`Share with ${shareTeam.name}`}
            checked={share}
            onChange={(event) => {
              setShare(event.target.checked);
            }}
          />
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
            Save view
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
  canEdit: boolean;
  /** The team new issues and shared views belong to, when there is one. */
  homeTeam?: TeamRead | undefined;
  emptyMessage?: string;
}

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
  canEdit,
  homeTeam,
  emptyMessage,
}) => {
  const auth = useQueryAuth();
  const navigate = useNavigate();
  const { user } = useAuth();
  const creator = useCreateIssue();
  const [params, setParams] = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);

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

  const scaleFor = useCallback(
    (teamId: string) =>
      teams.find((team) => team.id === teamId)?.estimate_scale ?? 'off',
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

  const saveNew = async (name: string, share: boolean): Promise<void> => {
    try {
      const created = await createView(
        workspaceId,
        stateToViewBody(state, name, scope, share ? homeTeam?.id : undefined)
      );
      refreshViewLists(workspaceId, homeTeam?.id);
      setSaving(false);
      showToast(`Saved view ${created.name}.`);
      void navigate(viewPath(slug, created.view_id));
    } catch (error) {
      showErrorToast(errorMessage(error, 'Could not save the view.'));
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

  const reset = (): void => {
    setParams(writeViewState(base, base, params), { replace: true });
  };

  const viewControls =
    view === undefined
      ? changed && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSaving(true);
            }}
          >
            Save view
          </Button>
        )
      : changed && (
          <>
            <Button size="sm" variant="ghost" onClick={reset}>
              Reset
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSaving(true);
              }}
            >
              Save as new
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={updating}
              onClick={() => void saveOver()}
            >
              Update view
            </Button>
          </>
        );

  const viewsMenu =
    view === undefined && (teamViews ?? []).length > 0 ? (
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
          context={lists.context}
          onChange={(filters) => {
            setState({ ...state, filters });
          }}
        />
        <span className="flex-1" />
        {viewControls}
        {viewsMenu}
        <DisplayMenu
          state={state}
          onChange={setState}
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
        context={lists.context}
        onChange={(filters) => {
          setState({ ...state, filters });
        }}
      />
    </div>
  );

  const scopedTeamId = scope.team_id;
  const share = !canEdit ? null : view !== undefined ? (
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
    canEdit && creator.canCreate ? (
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

  const actions =
    share === null && newIssue === null ? undefined : (
      <div className="flex items-center gap-1.5">
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
      <IssueListView
        slug={slug}
        state={state}
        onStateChange={setState}
        collection={collection}
        lists={lists}
        scaleFor={scaleFor}
        {...(teams.length > 1 ? { teamNameFor } : {})}
        canEdit={canEdit}
        createTeamId={homeTeam?.id}
        {...(emptyMessage === undefined ? {} : { emptyMessage })}
      />
      {saving && (
        <SaveViewDialog
          open
          onClose={() => {
            setSaving(false);
          }}
          shareTeam={homeTeam}
          initialName={view === undefined ? '' : `${view.name} copy`}
          onSave={saveNew}
        />
      )}
    </WorkspaceShell>
  );
};

export default IssueViewPage;
