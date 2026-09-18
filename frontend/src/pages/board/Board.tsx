/**
 * One project's board, with the filters it reads under and the saved views that
 * store those filters. Applying a saved view sets the filter state here and the
 * board re-reads under the new key, which is the same path a person typing into
 * the filter bar takes, so a stored view can never reach a row a live filter
 * could not.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { useParams } from 'react-router-dom';
import {
  listLabels,
  listProjectMembers,
  listProjects,
} from '../../api/projects';
import BoardView from '../../components/views/BoardView';
import SavedViewsPanel from '../../components/views/SavedViewsPanel';
import { ErrorAlert } from '../../components/ui/alert';
import { SelectField } from '../../components/ui/select';
import Spinner from '../../components/ui/spinner';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canWriteIssues } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/issueDisplay';
import { personLabel } from '../../lib/issuePeople';
import {
  labelsKey,
  projectMembersKey,
  projectsKey,
  type BoardKeyFilters,
} from '../../lib/queryKeys';
import type { SavedViewRead } from '../../types/Api';
import { fromViewFilter, toViewFilter } from '../../lib/viewFilters';

/** How often the supporting lists re-read. */
const POLL_MS = 60000;

/** The filters a board starts with, which is everything in the project. */
const NO_FILTERS: BoardKeyFilters = {
  assigneeId: '',
  labelId: '',
  priority: '',
};

/** The board for the project named by the route's key prefix. */
export const Board: React.FC = () => {
  const { slug, keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const { workspace } = useWorkspace();
  const auth = useQueryAuth();
  const [filters, setFilters] = useState<BoardKeyFilters>(NO_FILTERS);

  const workspaceId = workspace?.id ?? '';

  const { data: projects, error: projectsError } = usePolledQuery(
    ({ signal }) => listProjects(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: workspaceId !== '',
      queryKey: projectsKey(workspaceId),
      auth,
    }
  );

  const project = (projects ?? []).find(
    (item) => item.key_prefix === keyPrefix
  );
  const projectId = project?.id ?? '';
  const hasProject = projectId !== '';

  const { data: labels } = usePolledQuery(
    ({ signal }) => listLabels(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: labelsKey(projectId),
      auth,
    }
  );

  const { data: people } = usePolledQuery(
    ({ signal }) => listProjectMembers(workspaceId, projectId, signal),
    {
      intervalMs: POLL_MS,
      enabled: hasProject,
      queryKey: projectMembersKey(projectId),
      auth,
    }
  );

  const canEdit = canWriteIssues(workspace?.role, project?.role);

  const applyView = (view: SavedViewRead): void => {
    setFilters(fromViewFilter(view.filter));
  };

  if (projects === null) {
    return (
      <WorkspaceShell>
        {projectsError !== null ? (
          <ErrorAlert
            message={errorMessage(projectsError, 'Could not load the board.')}
          />
        ) : (
          <Spinner label="Loading board" />
        )}
      </WorkspaceShell>
    );
  }

  if (project === undefined) {
    return (
      <WorkspaceShell>
        <p className="text-sm text-slate-400">
          That project does not exist, or you are not a member of it.
        </p>
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <h2 className="text-xl font-semibold text-white">
          {project.name} board
        </h2>

        <div className="flex flex-wrap items-end gap-3">
          <SelectField
            id="board-assignee"
            label="Assignee"
            className="w-48"
            value={filters.assigneeId}
            onChange={(event) => {
              setFilters((held) => ({
                ...held,
                assigneeId: event.target.value,
              }));
            }}
          >
            <option value="">Anyone</option>
            {(people ?? []).map((person) => (
              <option key={person.user_id} value={person.user_id}>
                {personLabel(person)}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="board-label"
            label="Label"
            className="w-48"
            value={filters.labelId}
            onChange={(event) => {
              setFilters((held) => ({ ...held, labelId: event.target.value }));
            }}
          >
            <option value="">Any label</option>
            {(labels ?? []).map((label) => (
              <option key={label.id} value={label.id}>
                {label.name}
              </option>
            ))}
          </SelectField>

          <SelectField
            id="board-priority"
            label="Priority"
            className="w-44"
            value={filters.priority}
            onChange={(event) => {
              setFilters((held) => ({
                ...held,
                priority: event.target.value,
              }));
            }}
          >
            <option value="">Any priority</option>
            {PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </SelectField>
        </div>

        <BoardView
          workspaceId={workspaceId}
          projectId={projectId}
          slug={slug ?? ''}
          filters={filters}
          people={people ?? []}
          canEdit={canEdit}
        />

        <SavedViewsPanel
          workspaceId={workspaceId}
          projectId={projectId}
          currentFilter={toViewFilter(filters)}
          currentKind="board"
          onApply={applyView}
        />
      </div>
    </WorkspaceShell>
  );
};

export default Board;
