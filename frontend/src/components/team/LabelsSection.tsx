/**
 * The labels of one team: the team's own, which a team admin adds, renames,
 * recolors and deletes, and the workspace's, which the team inherits and can
 * only hide, show, rename for itself or reset. The list is read with the
 * hidden ones included, and every write also refreshes the visible list the
 * pickers read.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createLabel,
  deleteLabel,
  listLabels,
  overrideLabel,
  resetLabelOverride,
  updateLabel,
} from '../../api/teams';
import { errorMessage } from '../../lib/errors';
import { labelsSettingsPath } from '../../lib/paths';
import { allLabelsKey, labelsKey } from '../../lib/queryKeys';
import type {
  LabelCreate,
  LabelRead,
  LabelUpdate,
  OverrideUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Spinner from '../ui/spinner';
import LabelWorkflowEditor from '../workflow/LabelWorkflowEditor';

/** Props for LabelsSection: which team, and whether the caller may edit. */
export interface LabelsSectionProps {
  workspaceId: string;
  teamId: string;
  /** The workspace slug, for the link to the workspace's own labels. */
  slug?: string;
  /** The parent team's settings page, for a sub-team whose labels include the parent's. */
  parentSettingsPath?: string;
  canEdit: boolean;
}

/** How often the label list is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** Lists and edits a team's labels. */
export const LabelsSection: React.FC<LabelsSectionProps> = ({
  workspaceId,
  teamId,
  slug = '',
  parentSettingsPath,
  canEdit,
}) => {
  const auth = useQueryAuth();
  const keys = [allLabelsKey(teamId), labelsKey(teamId)];

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) =>
      listLabels(workspaceId, teamId, signal, { includeHidden: true }),
    {
      intervalMs: POLL_MS,
      queryKey: allLabelsKey(teamId),
      auth,
    }
  );

  const { mutate: create } = useMutationWithRefetch(
    (body: LabelCreate) => createLabel(workspaceId, teamId, body),
    keys
  );
  const { mutate: update } = useMutationWithRefetch(
    (label: LabelRead, body: LabelUpdate) =>
      updateLabel(workspaceId, teamId, label.id, body),
    keys
  );
  const { mutate: remove } = useMutationWithRefetch(
    (label: LabelRead) => deleteLabel(workspaceId, teamId, label.id),
    keys
  );
  const { mutate: override } = useMutationWithRefetch(
    (label: LabelRead, body: OverrideUpdate) =>
      overrideLabel(workspaceId, teamId, label.id, body),
    keys
  );
  const { mutate: reset } = useMutationWithRefetch(
    (label: LabelRead) => resetLabelOverride(workspaceId, teamId, label.id),
    keys
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Labels</h3>
        <p className="text-sm text-text-muted">
          Labels tag issues in this team. Labels marked Workspace come from
          workspace settings; this team can hide or rename them for itself.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the labels.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading labels" />
      ) : (
        <LabelWorkflowEditor
          labels={data}
          scope="team"
          canEdit={canEdit}
          workspaceSettingsPath={labelsSettingsPath(slug)}
          parentSettingsPath={
            parentSettingsPath === undefined
              ? undefined
              : `${parentSettingsPath}#team-settings-labels`
          }
          actions={{ create, update, remove, override, reset }}
        />
      )}
    </section>
  );
};

export default LabelsSection;
