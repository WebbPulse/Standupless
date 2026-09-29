/**
 * The Workflow page of workspace settings: the statuses every team inherits,
 * grouped by category. Any member reads them; a workspace owner or admin adds,
 * renames, recolors, recategorises, reorders and deletes them, and each write
 * refreshes every team's lists so the pickers pick it up at once.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createWorkspaceStatus,
  deleteWorkspaceStatus,
  listWorkspaceStatuses,
  updateWorkspaceStatus,
} from '../../api/workflow';
import { ErrorAlert } from '../../components/ui/alert';
import { SkeletonRows } from '../../components/ui/skeleton';
import StatusWorkflowEditor from '../../components/workflow/StatusWorkflowEditor';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  allStatusesKey,
  statusesKey,
  workspaceStatusesKey,
} from '../../lib/queryKeys';
import type { StatusCreate, StatusRead, StatusUpdate } from '../../types/Api';

/** How often the list is re-read while the page is open. */
const POLL_MS = 30000;

/** Lists and edits the workspace's inherited statuses. */
const WorkspaceWorkflowSettings: React.FC = () => {
  const auth = useQueryAuth();
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const workspaceId = workspace?.id ?? '';
  const canEdit = canManageMembers(workspace?.role);
  const keys = [
    workspaceStatusesKey(workspaceId),
    ...teams.flatMap((team) => [statusesKey(team.id), allStatusesKey(team.id)]),
  ];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceStatuses(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceStatusesKey(workspaceId),
      auth,
      enabled: workspaceId !== '',
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: StatusCreate) => createWorkspaceStatus(workspaceId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (status: StatusRead, body: StatusUpdate) =>
      updateWorkspaceStatus(workspaceId, status.id, body),
    keys
  );
  const { mutate: swap } = useMutationWithRefetch(
    async (first: StatusRead, second: StatusRead) => {
      await updateWorkspaceStatus(workspaceId, first.id, {
        position: second.position,
      });
      await updateWorkspaceStatus(workspaceId, second.id, {
        position: first.position,
      });
    },
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (status: StatusRead) => deleteWorkspaceStatus(workspaceId, status.id),
    keys
  );

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Workflow</h2>
          <p className="text-sm text-text-muted">
            Statuses defined here appear in every team, beside the team&apos;s
            own. A team can hide or rename one for itself, but only a workspace
            admin changes it here.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the statuses.')}
          />
        )}

        {isLoading || data === null ? (
          <SkeletonRows count={4} label="Loading statuses" />
        ) : (
          <StatusWorkflowEditor
            statuses={data}
            scope="workspace"
            canEdit={canEdit}
            actions={{ create, update, swap, remove }}
          />
        )}
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceWorkflowSettings;
