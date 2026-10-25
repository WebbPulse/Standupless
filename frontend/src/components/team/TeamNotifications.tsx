/**
 * A person's own notifications for one team: four switches that send the
 * team's new, triaged, completed and cancelled issues to their inbox. Every
 * switch starts off and saves as soon as it changes, and turning them all off
 * removes the subscription. The panel sits in the team's settings and the
 * dialog opens it from the team's sidebar menu.
 */

import React from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  getTeamSubscription,
  updateTeamSubscription,
} from '../../api/teamSubscriptions';
import { errorMessage } from '../../lib/errors';
import { teamSubscriptionKey } from '../../lib/queryKeys';
import { showToast } from '../../lib/toast';
import type { TeamSubscriptionEvent } from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Spinner from '../ui/spinner';

/** How often the subscription is re-read while it shows. */
const POLL_MS = 60000;

/** The four events in the order they show, with their labels. */
const EVENTS: { event: TeamSubscriptionEvent; label: string }[] = [
  { event: 'issue_created', label: 'Issue created' },
  { event: 'triage', label: 'Added to triage' },
  { event: 'completed', label: 'Completed' },
  { event: 'cancelled', label: 'Cancelled' },
];

/** Props for TeamNotificationsPanel: the team, and whether to read it now. */
export interface TeamNotificationsPanelProps {
  workspaceId: string;
  teamId: string;
  /** False holds the read, as a closed dialog does. */
  enabled?: boolean;
}

/** The four personal team notification switches. */
export const TeamNotificationsPanel: React.FC<TeamNotificationsPanelProps> = ({
  workspaceId,
  teamId,
  enabled = true,
}) => {
  const auth = useQueryAuth();
  const queryKey = teamSubscriptionKey(workspaceId, teamId);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => getTeamSubscription(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, enabled, queryKey, auth }
  );

  const {
    mutate: save,
    error: saveError,
    isMutating: saving,
  } = useMutationWithRefetch(
    (body: Partial<Record<TeamSubscriptionEvent, boolean>>) =>
      updateTeamSubscription(workspaceId, teamId, body),
    [queryKey]
  );

  const onFlip = async (
    event: TeamSubscriptionEvent,
    next: boolean
  ): Promise<void> => {
    if (saving) return;
    try {
      await save({ [event]: next });
      await refetch();
      showToast('Team notifications saved.');
    } catch {
      return;
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        Get an inbox notification when one of this team&apos;s issues is
        created, added to triage, completed or cancelled. Only you see these
        settings.
      </p>
      {error !== null && (
        <ErrorAlert
          message={errorMessage(
            error,
            'Could not load your team notifications.'
          )}
        />
      )}
      {saveError !== null && (
        <ErrorAlert
          message={errorMessage(
            saveError,
            'Could not save your team notifications.'
          )}
        />
      )}
      {isLoading && data === undefined ? (
        <Spinner label="Loading your team notifications" />
      ) : (
        <div className="flex flex-col gap-2">
          {EVENTS.map(({ event, label }) => (
            <Checkbox
              key={event}
              label={label}
              checked={data?.[event] ?? false}
              disabled={saving || data === undefined}
              onChange={(changed) => {
                void onFlip(event, changed.target.checked);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Props for TeamNotificationsDialog: the team, and whether the dialog shows. */
export interface TeamNotificationsDialogProps {
  workspaceId: string;
  teamId: string;
  teamName: string;
  open: boolean;
  onClose: () => void;
}

/** The team notification switches in a dialog, opened from the sidebar. */
export const TeamNotificationsDialog: React.FC<
  TeamNotificationsDialogProps
> = ({ workspaceId, teamId, teamName, open, onClose }) => (
  <Dialog
    open={open}
    onClose={onClose}
    title={`${teamName} notifications`}
    size="sm"
  >
    <TeamNotificationsPanel
      workspaceId={workspaceId}
      teamId={teamId}
      enabled={open}
    />
  </Dialog>
);

export default TeamNotificationsDialog;
