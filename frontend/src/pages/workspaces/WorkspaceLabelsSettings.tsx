/**
 * The Labels page of workspace settings: the labels every team inherits. Any
 * member reads them; a workspace owner or admin adds, renames, recolors and
 * deletes them, and each write refreshes every team's lists so the pickers
 * pick it up at once.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createWorkspaceLabel,
  deleteWorkspaceLabel,
  listWorkspaceLabels,
  updateWorkspaceLabel,
} from '../../api/workflow';
import { ErrorAlert } from '../../components/ui/alert';
import { SkeletonRows } from '../../components/ui/skeleton';
import LabelWorkflowEditor from '../../components/workflow/LabelWorkflowEditor';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useTeam } from '../../hooks/useTeam';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { errorMessage } from '../../lib/errors';
import {
  allLabelsKey,
  labelsKey,
  workspaceLabelsKey,
} from '../../lib/queryKeys';
import type { LabelCreate, LabelRead, LabelUpdate } from '../../types/Api';

/** How often the list is re-read while the page is open. */
const POLL_MS = 30000;

/** Lists and edits the workspace's inherited labels. */
const WorkspaceLabelsSettings: React.FC = () => {
  const auth = useQueryAuth();
  const { workspace } = useWorkspace();
  const { teams } = useTeam(undefined);
  const workspaceId = workspace?.id ?? '';
  const canEdit = canManageMembers(workspace?.role);
  const keys = [
    workspaceLabelsKey(workspaceId),
    ...teams.flatMap((team) => [labelsKey(team.id), allLabelsKey(team.id)]),
  ];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWorkspaceLabels(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: workspaceLabelsKey(workspaceId),
      auth,
      enabled: workspaceId !== '',
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: LabelCreate) => createWorkspaceLabel(workspaceId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (label: LabelRead, body: LabelUpdate) =>
      updateWorkspaceLabel(workspaceId, label.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (label: LabelRead) => deleteWorkspaceLabel(workspaceId, label.id),
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
          <h2 className="text-base font-semibold">Labels</h2>
          <p className="text-sm text-text-muted">
            Labels defined here appear in every team, beside the team&apos;s
            own. A team can hide or rename one for itself, but only a workspace
            admin changes it here.
          </p>
        </div>

        {error !== null && (
          <ErrorAlert
            message={errorMessage(error, 'Could not load the labels.')}
          />
        )}

        {isLoading || data === null ? (
          <SkeletonRows count={4} label="Loading labels" />
        ) : (
          <LabelWorkflowEditor
            labels={data}
            scope="workspace"
            canEdit={canEdit}
            actions={{ create, update, remove }}
          />
        )}
      </div>
    </WorkspaceShell>
  );
};

export default WorkspaceLabelsSettings;
