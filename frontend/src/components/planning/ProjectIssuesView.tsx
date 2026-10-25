/**
 * A project's issues as a list or a board, with the same filters, display
 * options and keyboard as a team's issues. Inside one project the view also
 * knows the project's milestones, so it can group and filter by milestone
 * and the "Set milestone" command is offered on its issues. The filters and
 * display live in the URL beside the page's own tab parameter. Issues still
 * waiting in a team's triage stay out unless the viewer turns on "Show triage
 * issues", a choice remembered in this browser per project.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useIssueCollection } from '../../hooks/useIssueCollection';
import { useListFolds } from '../../hooks/useListFolds';
import {
  useIssueContext,
  type IssueContextState,
} from '../../hooks/useIssueContext';
import {
  defaultViewState,
  groupFieldsFor,
  parseViewState,
  sameViewState,
  viewStateQuery,
  writeViewState,
  type ViewState,
} from '../../lib/issueView';
import {
  readProjectShowTriage,
  rememberProjectShowTriage,
} from '../../lib/projectTriage';
import { estimateOptionsOf } from '../../lib/validation';
import type { MilestoneRead, TeamRead } from '../../types/Api';
import DisplayMenu from '../issues/view/DisplayMenu';
import {
  FilterButton,
  FilterChips,
  type FilterLogic,
} from '../issues/view/FilterBar';
import IssueListView from '../issues/view/IssueListView';

/** The settings a project's issues open with. */
export const PROJECT_VIEW_BASE: ViewState = defaultViewState('list');

/** Props for ProjectIssuesView. */
export interface ProjectIssuesViewProps {
  workspaceId: string;
  slug: string;
  projectId: string;
  /** The teams the project belongs to, whose issues it can hold. */
  teams: TeamRead[];
  milestones: MilestoneRead[];
  canEdit: boolean;
  /** The team a new issue is filed into, when the caller can write in one. */
  createTeamId?: string | undefined;
}

/** The view. */
export const ProjectIssuesView: React.FC<ProjectIssuesViewProps> = ({
  workspaceId,
  slug,
  projectId,
  teams,
  milestones,
  canEdit,
  createTeamId,
}) => {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const base = PROJECT_VIEW_BASE;
  const state = useMemo(() => parseViewState(params, base), [params, base]);
  const setState = useCallback(
    (next: ViewState) => {
      setParams(writeViewState(next, base, params), { replace: true });
    },
    [setParams, base, params]
  );
  const folds = useListFolds(
    workspaceId,
    projectId === '' ? undefined : `project:${projectId}`
  );

  const [triage, setTriage] = useState(() => ({
    projectId,
    shown: readProjectShowTriage(projectId),
  }));
  const showTriage =
    triage.projectId === projectId
      ? triage.shown
      : readProjectShowTriage(projectId);
  const changeTriage = useCallback(
    (shown: boolean) => {
      rememberProjectShowTriage(projectId, shown);
      setTriage({ projectId, shown });
    },
    [projectId]
  );

  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const scope = useMemo(
    () => ({
      project_id: projectId,
      ...(showTriage ? { include_triage: true } : {}),
    }),
    [projectId, showTriage]
  );
  const collection = useIssueCollection(
    workspaceId,
    `project:${projectId}`,
    viewStateQuery(state, scope),
    workspaceId !== '' && projectId !== ''
  );
  const teamLists = useIssueContext(workspaceId, teamIds, user?.id);
  const lists = useMemo<IssueContextState>(
    () => ({
      ...teamLists,
      context: { ...teamLists.context, milestones },
      forTeam: (teamId) => ({ ...teamLists.forTeam(teamId), milestones }),
    }),
    [teamLists, milestones]
  );

  const scaleFor = useCallback(
    (teamId: string) =>
      teams.find((team) => team.id === teamId)?.estimate_scale ?? 'off',
    [teams]
  );
  const countsUnestimated = useCallback(
    (teamId: string) =>
      teams.find((team) => team.id === teamId)?.estimate_count_unestimated ===
      true,
    [teams]
  );
  const listEstimates = teams.some((team) => team.estimate_scale !== 'off');
  const estimateOptionsFor = useCallback(
    (teamId: string) =>
      estimateOptionsOf(teams.find((team) => team.id === teamId)),
    [teams]
  );
  const teamNameFor = useCallback(
    (teamId: string) => teams.find((team) => team.id === teamId)?.name,
    [teams]
  );
  const setFilters = (filters: ViewState['filters']): void => {
    setState({ ...state, filters });
  };
  const setLogic = (logic: FilterLogic): void => {
    setState({ ...state, ...logic });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-line px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <FilterButton
            filters={state.filters}
            match={state.match}
            groups={state.groups}
            context={lists.context}
            onChange={setFilters}
            onLogicChange={setLogic}
          />
          <span className="flex-1" />
          <DisplayMenu
            state={state}
            onChange={setState}
            groupFields={groupFieldsFor(lists.context)}
            context={lists.context}
            estimates={listEstimates}
            triage={{ shown: showTriage, onChange: changeTriage }}
            onReset={
              !showTriage &&
              folds.collapsed.size === 0 &&
              sameViewState(
                {
                  ...state,
                  filters: base.filters,
                  match: base.match,
                  groups: base.groups,
                  q: base.q,
                },
                base
              )
                ? undefined
                : () => {
                    changeTriage(false);
                    folds.clear();
                    setState({
                      ...base,
                      filters: state.filters,
                      match: state.match,
                      groups: state.groups,
                      q: state.q,
                    });
                  }
            }
          />
        </div>
        <FilterChips
          filters={state.filters}
          match={state.match}
          groups={state.groups}
          context={lists.context}
          onChange={setFilters}
          onLogicChange={setLogic}
        />
      </div>
      <IssueListView
        slug={slug}
        state={state}
        onStateChange={setState}
        collection={collection}
        lists={lists}
        scaleFor={scaleFor}
        countsUnestimated={countsUnestimated}
        estimateOptionsFor={estimateOptionsFor}
        {...(teams.length > 1 ? { teamNameFor } : {})}
        canEdit={canEdit}
        createTeamId={createTeamId}
        createProjectId={projectId}
        folds={{
          collapsed: folds.collapsed,
          onToggle: folds.toggle,
          onSet: folds.set,
        }}
        emptyMessage={
          state.filters.length === 0
            ? 'No issues are in this project yet.'
            : 'No issues match these filters.'
        }
      />
    </div>
  );
};

export default ProjectIssuesView;
