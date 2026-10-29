/**
 * A team's Slack switches: status posts into the threads its issues came from,
 * and private asks from direct messages and private channels.
 *
 * An issue filed from Slack, by the message shortcut, the slash command, an
 * emoji reaction or a request form, stays paired with its thread. With the
 * switch on, the bot tells that thread when the issue leaves triage, starts,
 * completes, is cancelled or is marked a duplicate. It is on until a team admin
 * turns it off, and the section shows only where this environment has a Slack App.
 *
 * With private asks on, the team's Slack request forms offer a "Private" option,
 * checked to start with in a direct message with the bot. A private ask is seen
 * only by its requester and the team's members, and syncs only with the direct
 * message or private channel it came from. Private asks are off until turned on.
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
import type { SlackStatusPostsWrite } from '../../types/Api';
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

/** Shows and flips a team's Slack status posts and private asks switches. */
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
    async (change: SlackStatusPostsWrite) => {
      await saveSlackStatusPosts(workspaceId, teamId, change);
    },
    [queryKey]
  );

  if (data !== null && !data.configured) return null;

  const flip = async (
    change: SlackStatusPostsWrite,
    toast: string
  ): Promise<void> => {
    if (!canEdit) return;
    try {
      await save(change);
      await refetch();
      showToast(toast);
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
        <div className="space-y-2">
          <Checkbox
            label="Post status changes in the originating Slack thread"
            checked={data.enabled}
            disabled={saving}
            onChange={(event) => {
              const enabled = event.target.checked;
              void flip(
                { enabled },
                enabled
                  ? 'Slack status posts turned on'
                  : 'Slack status posts turned off'
              );
            }}
          />
          <Checkbox
            label="Allow private asks from Slack DMs and private channels"
            checked={data.private_asks}
            disabled={saving}
            onChange={(event) => {
              const privateAsks = event.target.checked;
              void flip(
                { private_asks: privateAsks },
                privateAsks
                  ? 'Private Slack asks turned on'
                  : 'Private Slack asks turned off'
              );
            }}
          />
          <p className="text-sm text-text-muted">
            A private ask is seen only by the person who asked and this
            team&apos;s members, and its updates go only to the DM or private
            channel it came from.
          </p>
        </div>
      ) : (
        <div className="space-y-1 text-sm text-text-muted">
          <p>
            {data.enabled
              ? 'Status changes are posted in the originating Slack thread.'
              : 'Status changes are not posted to Slack.'}
          </p>
          <p>
            {data.private_asks
              ? 'Requests from Slack DMs and private channels can be private.'
              : 'Requests from Slack are visible to everyone who can see this team.'}
          </p>
        </div>
      )}
    </section>
  );
};

export default SlackStatusPostsSection;
