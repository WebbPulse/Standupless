/**
 * The workflow statuses of one team, grouped by category: the team's own,
 * which a team admin adds, renames, recolors, recategorises, reorders and
 * deletes, and the workspace's, which the team inherits and can only hide,
 * show, rename for itself or reset. The list is read with the hidden ones
 * included, and every write also refreshes the visible list the pickers read.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createStatus,
  deleteStatus,
  listStatuses,
  overrideStatus,
  resetStatusOverride,
  updateStatus,
} from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { workflowSettingsPath } from '../../lib/paths';
import { allStatusesKey, statusesKey } from '../../lib/queryKeys';
import type {
  OverrideUpdate,
  StatusCreate,
  StatusRead,
  StatusUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Spinner from '../ui/spinner';
import StatusWorkflowEditor from '../workflow/StatusWorkflowEditor';

/** Props for StatusesSection: which team, and whether the caller may edit. */
export interface StatusesSectionProps {
  workspaceId: string;
  teamId: string;
  /** The workspace slug, for the link to the workspace's own statuses. */
  slug?: string;
  /** The parent team's settings page, for a sub-team whose statuses include the parent's. */
  parentSettingsPath?: string;
  canEdit: boolean;
}

/** How often the status list is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** Lists and edits a team's workflow statuses. */
export const StatusesSection: React.FC<StatusesSectionProps> = ({
  workspaceId,
  teamId,
  slug = '',
  parentSettingsPath,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const keys = [allStatusesKey(teamId), statusesKey(teamId)];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listStatuses(workspaceId, teamId, signal, { includeHidden: true }),
    {
      intervalMs: POLL_MS,
      queryKey: allStatusesKey(teamId),
      auth,
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: StatusCreate) => createStatus(workspaceId, teamId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (status: StatusRead, body: StatusUpdate) =>
      updateStatus(workspaceId, teamId, status.id, body),
    keys
  );
  const { mutate: swap } = useMutationWithRefetch(
    async (first: StatusRead, second: StatusRead) => {
      await updateStatus(workspaceId, teamId, first.id, {
        position: second.position,
      });
      await updateStatus(workspaceId, teamId, second.id, {
        position: first.position,
      });
    },
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (status: StatusRead, replacementId?: string) =>
      deleteStatus(workspaceId, teamId, status.id, replacementId),
    keys
  );
  const { mutate: override } = useMutationWithRefetch(
    (status: StatusRead, body: OverrideUpdate) =>
      overrideStatus(workspaceId, teamId, status.id, body),
    keys
  );
  const { mutate: reset } = useMutationWithRefetch(
    (status: StatusRead) => resetStatusOverride(workspaceId, teamId, status.id),
    keys
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Statuses</h3>
        <p className="text-sm text-text-muted">
          The workflow an issue moves through. Statuses marked Workspace come
          from workspace settings; this team can hide or rename them for itself.
          Every category in use keeps at least one visible status.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the statuses.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading statuses" />
      ) : (
        <StatusWorkflowEditor
          statuses={data}
          scope="team"
          canEdit={canEdit}
          workspaceSettingsPath={workflowSettingsPath(slug)}
          parentSettingsPath={
            parentSettingsPath === undefined
              ? undefined
              : `${parentSettingsPath}#team-settings-workflow`
          }
          actions={{ create, update, swap, remove, override, reset }}
        />
      )}
    </section>
  );
};

export default StatusesSection;
