/**
 * A team's switch for status posts into the Slack threads its issues came from.
 *
 * An issue filed from Slack, by the message shortcut, the slash command, an
 * emoji reaction or a request form, stays paired with its thread. With the
 * switch on, the bot tells that thread when the issue leaves triage, starts,
 * completes, is cancelled or is marked a duplicate. It is on until a team admin
 * turns it off, and the section shows only where this environment has a Slack App.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
  type QueryKey,
} from '@webbpulse/api-client/react';
import {
  getSlackStatusPosts,
  saveSlackStatusPosts,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { showToast } from '../../lib/toast';
import { ErrorAlert } from '../ui/alert';
import { Checkbox } from '../ui/checkbox';
import Spinner from '../ui/spinner';

/** Props for SlackStatusPostsSection: which team, and whether the caller may edit. */
export interface SlackStatusPostsSectionProps {
  workspaceId: string;
  teamId: string;
  /** Whether the caller administers the team. */
  canEdit: boolean;
}

/** How often the switch is re-read while the tab is open. */
const POLL_MS = 60000;

/** Shows and flips a team's Slack status posts switch. */
export const SlackStatusPostsSection: React.FC<
  SlackStatusPostsSectionProps
> = ({ workspaceId, teamId, canEdit }) => {
  const auth = useQueryAuth();
  const queryKey: QueryKey = ['slack-status-posts', workspaceId, teamId];

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getSlackStatusPosts(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    async (enabled: boolean) => {
      await saveSlackStatusPosts(workspaceId, teamId, { enabled });
    },
    [queryKey]
  );

  if (data !== null && !data.configured) return null;

  const flip = async (enabled: boolean): Promise<void> => {
    if (!canEdit) return;
    try {
      await save(enabled);
      await refetch();
      showToast(
        enabled
          ? 'Slack status posts turned on'
          : 'Slack status posts turned off'
      );
    } catch {
      return;
    }
  };

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">
          Post status to Slack threads
        </h3>
        <p className="text-sm text-text-muted">
          When an issue filed from Slack is accepted or declined in triage,
          starts, completes, is cancelled or is marked a duplicate, the bot
          posts one short message in the thread it came from. Changes made
          within a minute of each other post once.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load the Slack status post setting.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not change the Slack status post setting.'
          )}
        />
      )}

      {isLoading && data === null ? (
        <Spinner label="Loading the Slack status post setting" />
      ) : data === null ? null : canEdit ? (
        <Checkbox
          label="Post status changes in the originating Slack thread"
          checked={data.enabled}
          disabled={saving}
          onChange={(event) => {
            void flip(event.target.checked);
          }}
        />
      ) : (
        <p className="text-sm text-text-muted">
          {data.enabled
            ? 'Status changes are posted in the originating Slack thread.'
            : 'Status changes are not posted to Slack.'}
        </p>
      )}
    </section>
  );
};

export default SlackStatusPostsSection;
