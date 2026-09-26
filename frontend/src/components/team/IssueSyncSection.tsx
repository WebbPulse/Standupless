/**
 * A team's two way issue sync with one GitHub repository: which repository,
 * which way changes flow, whether labels follow, and a pause switch.
 *
 * Each control saves as it changes, like the transition rules beside it. A
 * repository syncs with at most one team, so picking one another team already
 * holds shows the server's refusal rather than silently moving it. Choosing the
 * repository reads the installation's repository list, which only a workspace
 * admin may do, so a team admin who is not one sees the link but cannot change
 * which repository it points at.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  deleteTeamSync,
  getTeamSync,
  listRepositories,
  putTeamSync,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { repositoriesKey, teamSyncKey } from '../../lib/queryKeys';
import type {
  GithubSyncDirection,
  TeamSyncRead,
  TeamSyncWrite,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import { Select } from '../ui/select';
import Spinner from '../ui/spinner';

/** Props for IssueSyncSection. */
export interface IssueSyncSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
  /** Whether the caller may list the installation's repositories. */
  canPickRepository: boolean;
}

/** How often the link is re-read while the settings tab is open. */
const POLL_MS = 30000;

/** How each direction reads in the interface. */
const DIRECTION_LABELS: Record<GithubSyncDirection, string> = {
  two_way: 'Both ways',
  github_to_standupless: 'GitHub to Standupless only',
};

/** The write that keeps every setting of `current` and changes `changes`. */
const merged = (
  current: TeamSyncRead,
  changes: Partial<TeamSyncWrite>
): TeamSyncWrite => ({
  repository_id: current.repository_id,
  direction: current.direction,
  enabled: current.enabled,
  sync_labels: current.sync_labels,
  ...changes,
});

/** Shows and edits the team's issue sync link. */
export const IssueSyncSection: React.FC<IssueSyncSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  canPickRepository,
}) => {
  const auth = useQueryAuth();
  const queryKey = teamSyncKey(workspaceId, teamId);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => getTeamSync(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: repositories, error: repositoriesError } = usePolledQuery(
    ({ signal }) => listRepositories(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      queryKey: repositoriesKey(workspaceId),
      auth,
      enabled: canEdit && canPickRepository,
    }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (payload: TeamSyncWrite) => putTeamSync(workspaceId, teamId, payload),
    queryKey
  );

  const {
    mutate: unlink,
    error: unlinkError,
    isMutating: unlinking,
  } = useMutationWithRefetch(
    () => deleteTeamSync(workspaceId, teamId),
    queryKey
  );

  const link = data ?? null;
  const busy = !canEdit || saving || unlinking;

  const change = (changes: Partial<TeamSyncWrite>): void => {
    if (link === null) {
      if (changes.repository_id === undefined) return;
      void save({ repository_id: changes.repository_id }).catch(
        () => undefined
      );
      return;
    }
    void save(merged(link, changes)).catch(() => undefined);
  };

  const options = repositories ?? [];
  const known =
    link === null ||
    options.some((row) => row.repository_id === link.repository_id);

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">Issue sync</h3>
        <p className="text-sm text-text-muted">
          Mirror this team&apos;s issues with one GitHub repository. New GitHub
          issues are imported here, and titles, descriptions, status, assignees,
          labels and comments stay in step. When both sides change the same
          field, the later edit is kept and the other is noted in the issue
          history. Deleting an issue or a comment on either side is not synced.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the issue sync.')}
        />
      )}
      {repositoriesError !== null && (
        <ErrorAlert
          message={errorMessage(
            repositoriesError,
            'Could not load the repositories.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(saveError, 'Could not save the issue sync.')}
        />
      )}
      {unlinkError !== null && (
        <ErrorAlert
          message={errorMessage(unlinkError, 'Could not stop the issue sync.')}
        />
      )}

      {isLoading && data === undefined ? (
        <Spinner label="Loading the issue sync" />
      ) : (
        <div className="space-y-3 rounded-md border border-line px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="issue-sync-repository"
              className="text-sm font-medium text-text"
            >
              Repository
            </label>
            {canEdit && canPickRepository ? (
              <Select
                id="issue-sync-repository"
                className="w-64"
                value={link?.repository_id ?? ''}
                disabled={busy}
                onChange={(event) => {
                  if (event.target.value !== '') {
                    change({ repository_id: event.target.value });
                  }
                }}
              >
                {link === null && <option value="">Not synced</option>}
                {!known && link !== null && (
                  <option value={link.repository_id}>{link.full_name}</option>
                )}
                {options.map((row) => (
                  <option key={row.repository_id} value={row.repository_id}>
                    {row.full_name}
                  </option>
                ))}
              </Select>
            ) : (
              <p id="issue-sync-repository" className="text-sm text-text-muted">
                {link === null ? 'Not synced' : link.full_name}
              </p>
            )}
          </div>

          {link !== null && (
            <>
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="issue-sync-direction"
                  className="text-sm font-medium text-text"
                >
                  Direction
                </label>
                <Select
                  id="issue-sync-direction"
                  className="w-64"
                  value={link.direction}
                  disabled={busy}
                  onChange={(event) => {
                    change({
                      direction: event.target.value as GithubSyncDirection,
                    });
                  }}
                >
                  {(Object.keys(DIRECTION_LABELS) as GithubSyncDirection[]).map(
                    (direction) => (
                      <option key={direction} value={direction}>
                        {DIRECTION_LABELS[direction]}
                      </option>
                    )
                  )}
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <Checkbox
                  label="Sync labels"
                  checked={link.sync_labels}
                  disabled={busy}
                  onChange={(event) => {
                    change({ sync_labels: event.target.checked });
                  }}
                />
                <Checkbox
                  label="Sync is on"
                  checked={link.enabled}
                  disabled={busy}
                  onChange={(event) => {
                    change({ enabled: event.target.checked });
                  }}
                />
              </div>
              {canEdit && (
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      void unlink().catch(() => undefined);
                    }}
                  >
                    Stop syncing
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};

export default IssueSyncSection;
