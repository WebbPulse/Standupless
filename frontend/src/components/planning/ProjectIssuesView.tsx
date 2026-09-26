/**
 * A project's issues as a list or a board, with the same filters, display
 * options and keyboard as a team's issues. Inside one project the view also
 * knows the project's milestones, so it can group and filter by milestone
 * and the "Set milestone" command is offered on its issues. The filters and
 * display live in the URL beside the page's own tab parameter.
 */

import React, { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useIssueCollection } from '../../hooks/useIssueCollection';
import {
  useIssueContext,
  type IssueContextState,
} from '../../hooks/useIssueContext';
import {
  GROUP_FIELDS,
  defaultViewState,
  fieldsFor,
  parseViewState,
  sameViewState,
  viewStateQuery,
  writeViewState,
  type ViewState,
} from '../../lib/issueView';
import type { MilestoneRead, TeamRead } from '../../types/Api';
import DisplayMenu from '../issues/view/DisplayMenu';
import { FilterButton, FilterChips } from '../issues/view/FilterBar';
import IssueListView from '../issues/view/IssueListView';

/** The settings a project's issues open with. */
const PROJECT_VIEW_BASE: ViewState = defaultViewState('list');

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

  const teamIds = useMemo(() => teams.map((team) => team.id), [teams]);
  const scope = useMemo(() => ({ project_id: projectId }), [projectId]);
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
  const teamNameFor = useCallback(
    (teamId: string) => teams.find((team) => team.id === teamId)?.name,
    [teams]
  );
  const setFilters = (filters: ViewState['filters']): void => {
    setState({ ...state, filters });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b border-line px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <FilterButton
            filters={state.filters}
            context={lists.context}
            onChange={setFilters}
          />
          <span className="flex-1" />
          <DisplayMenu
            state={state}
            onChange={setState}
            groupFields={fieldsFor(GROUP_FIELDS, lists.context)}
            onReset={
              sameViewState(
                { ...state, filters: base.filters, q: base.q },
                base
              )
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
          onChange={setFilters}
        />
      </div>
      <IssueListView
        slug={slug}
        state={state}
        onStateChange={setState}
        collection={collection}
        lists={lists}
        scaleFor={scaleFor}
        {...(teams.length > 1 ? { teamNameFor } : {})}
        canEdit={canEdit}
        createTeamId={createTeamId}
        createProjectId={projectId}
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
