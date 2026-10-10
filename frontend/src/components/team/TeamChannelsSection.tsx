/**
 * The Slack and Discord channels one team posts its notifications to: a list
 * of channels with their provider, masked URL, events and last response, an
 * enabled switch on each row, and actions to edit, send a test message or
 * remove one.
 *
 * When this environment offers the Slack App, a row above the list says
 * whether the workspace installed it: a workspace admin adds it from there,
 * which returns here, or removes it behind a confirm. Once installed, a new
 * channel can be a Slack channel the bot posts to, picked by name.
 *
 * Only a team admin may read them, so anybody else is told who can rather
 * than shown a read the API refuses. A channel the server turned off because
 * its webhook is gone carries a warning with its own re-enable action, since
 * the person reading the list did not turn it off and may not know why it
 * went quiet.
 */

import React, { useCallback, useState } from 'react';
import {
  LuEllipsis,
  LuPencil,
  LuPlus,
  LuSend,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createChannel,
  deleteChannel,
  deleteSlackConnection,
  getSlackConnection,
  getSlackInstallUrl,
  listChannels,
  testChannel,
  updateChannel,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { channelsKey, slackConnectionKey } from '../../lib/queryKeys';
import { fullTimestamp } from '../../lib/relativeTime';
import type {
  ChannelProvider,
  ChannelRead,
  ChannelTestRead,
  ChannelUpdate,
  SlackConnectionRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';
import { statusCodeLabel, statusCodeTone } from '../webhooks/webhookDisplay';
import ChannelFormDialog, { type ChannelFormBody } from './ChannelFormDialog';
import { channelEventsLabel } from './channelDisplay';

/** Props for TeamChannelsSection: which team, and whether the caller may manage it. */
export interface TeamChannelsSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
  /** Whether the caller administers the workspace, which adding or removing the Slack App takes. */
  canManageWorkspace?: boolean;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** How each provider reads in the list. */
const PROVIDER_LABELS: Record<ChannelProvider, string> = {
  slack: 'Slack',
  discord: 'Discord',
};

/** Which form, if any, is open: a new channel or an edit of one. */
type FormState = { mode: 'create' } | { mode: 'edit'; channel: ChannelRead };

/** The last test message's outcome, against the channel it was sent to. */
interface TestOutcome {
  channelId: string;
  result: ChannelTestRead;
}

/** A channel's name as the list shows it: its label, or its masked URL. */
const channelName = (channel: ChannelRead): string =>
  channel.label === '' ? channel.url_hint : channel.label;

/** Props for SlackConnectionRow. */
interface SlackConnectionRowProps {
  workspaceId: string;
  teamId: string;
  connection: SlackConnectionRead;
  canManageWorkspace: boolean;
  /** Re-reads the connection and the channels once the App is removed. */
  onDisconnected: () => void;
}

/** Whether the workspace installed the Slack App, with the admin's add or remove action. */
const SlackConnectionRow: React.FC<SlackConnectionRowProps> = ({
  workspaceId,
  teamId,
  connection,
  canManageWorkspace,
  onDisconnected,
}) => {
  const [opening, setOpening] = useState(false);
  const [installError, setInstallError] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<unknown>(null);

  const onInstall = (): void => {
    setOpening(true);
    setInstallError(null);
    void getSlackInstallUrl(workspaceId, teamId)
      .then((result) => {
        globalThis.location.assign(result.url);
      })
      .catch((reason: unknown) => {
        setInstallError(reason);
        setOpening(false);
      });
  };

  const onDisconnect = (): void => {
    setDisconnecting(true);
    setDisconnectError(null);
    void deleteSlackConnection(workspaceId)
      .then(() => {
        setConfirming(false);
        onDisconnected();
      })
      .catch((reason: unknown) => {
        setDisconnectError(reason);
      })
      .finally(() => {
        setDisconnecting(false);
      });
  };

  const teamName = connection.slack_team_name ?? 'a Slack workspace';

  return (
    <div className="space-y-2">
      {installError !== null && (
        <ErrorAlert
          message={errorMessage(installError, 'Could not open Slack.')}
        />
      )}
      <div className="flex min-h-row items-center gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-medium text-text">Slack app</span>
            {connection.installed ? (
              <Badge tone="success">Connected</Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>
          <p className="truncate text-xs text-text-muted">
            {connection.installed
              ? `Posts as a bot in ${teamName}, unfurls issue links and adds the /standupless command.`
              : canManageWorkspace
                ? 'Pick Slack channels by name, unfurl issue links and create issues from Slack.'
                : 'A workspace admin can add the Slack app to pick channels by name.'}
          </p>
        </div>
        {canManageWorkspace &&
          (connection.installed ? (
            <Button
              size="sm"
              onClick={() => {
                setDisconnectError(null);
                setConfirming(true);
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button size="sm" disabled={opening} onClick={onInstall}>
              {opening ? 'Opening Slack' : 'Add to Slack'}
            </Button>
          ))}
      </div>

      <Dialog
        open={confirming}
        onClose={() => {
          if (!disconnecting) setConfirming(false);
        }}
        title="Disconnect Slack?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Standupless leaves {teamName} for every team in this workspace.
            Channels that post through the Slack app stop receiving
            notifications, and issue links no longer unfurl. Webhook channels
            keep working.
          </p>
          {disconnectError !== null && (
            <ErrorAlert
              message={errorMessage(
                disconnectError,
                'Could not disconnect Slack.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={disconnecting}
              onClick={onDisconnect}
            >
              {disconnecting ? 'Disconnecting' : 'Disconnect Slack'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};

/** Props for ChannelsPanel. */
interface ChannelsPanelProps {
  workspaceId: string;
  teamId: string;
  canManageWorkspace: boolean;
}

/** The channels list itself, for a team admin. */
const ChannelsPanel: React.FC<ChannelsPanelProps> = ({
  workspaceId,
  teamId,
  canManageWorkspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = channelsKey(workspaceId, teamId);
  const [form, setForm] = useState<FormState | null>(null);
  const [removing, setRemoving] = useState<ChannelRead | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const { data, error, isLoading, refetch } = usePolledQuery(
    ({ signal }) => listChannels(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const { data: slack, refetch: refetchSlack } = usePolledQuery(
    ({ signal }) => getSlackConnection(workspaceId, signal),
    { intervalMs: POLL_MS, queryKey: slackConnectionKey(workspaceId), auth }
  );
  const slackInstalled = slack?.installed === true;

  const onSlackDisconnected = useCallback((): void => {
    void refetchSlack().catch(() => undefined);
    void refetch().catch(() => undefined);
  }, [refetch, refetchSlack]);

  const {
    mutate: create,
    isMutating: creating,
    error: createError,
  } = useMutationWithRefetch(
    (body: ChannelFormBody) =>
      createChannel(workspaceId, teamId, {
        ...(body.slack_channel_id === undefined
          ? { url: body.url ?? '' }
          : {
              slack_channel_id: body.slack_channel_id,
              ...(body.slack_channel_name === undefined
                ? {}
                : { slack_channel_name: body.slack_channel_name }),
            }),
        events: body.events ?? [],
        ...(body.label === undefined ? {} : { label: body.label }),
      }),
    queryKey
  );

  const {
    mutate: save,
    isMutating: saving,
    error: saveError,
  } = useMutationWithRefetch(
    (input: { channelId: string; body: ChannelUpdate }) =>
      updateChannel(workspaceId, teamId, input.channelId, input.body),
    queryKey
  );

  const { mutate: toggle, error: toggleError } = useMutationWithRefetch(
    (input: { channelId: string; enabled: boolean }) =>
      updateChannel(workspaceId, teamId, input.channelId, {
        enabled: input.enabled,
      }),
    queryKey
  );

  const { mutate: sendTest, error: testError } = useMutationWithRefetch(
    (channelId: string) => testChannel(workspaceId, teamId, channelId),
    queryKey
  );

  const {
    mutate: remove,
    isMutating: deleting,
    error: removeError,
  } = useMutationWithRefetch(
    (channelId: string) => deleteChannel(workspaceId, teamId, channelId),
    queryKey
  );

  const onSave = async (body: ChannelFormBody): Promise<void> => {
    if (form?.mode === 'edit') {
      await save({ channelId: form.channel.channel_id, body });
    } else {
      await create(body);
    }
    setForm(null);
  };

  const onTest = (channel: ChannelRead): void => {
    setOutcome(null);
    void sendTest(channel.channel_id)
      .then((result) => {
        setOutcome({ channelId: channel.channel_id, result });
      })
      .catch(() => undefined);
  };

  const onRemove = (): void => {
    if (removing === null) return;
    const { channel_id: channelId } = removing;
    void remove(channelId)
      .then(() => {
        setRemoving(null);
        if (outcome?.channelId === channelId) setOutcome(null);
      })
      .catch(() => undefined);
  };

  const setEnabled = (channel: ChannelRead, enabled: boolean): void => {
    void toggle({ channelId: channel.channel_id, enabled }).catch(
      () => undefined
    );
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Notifications</h3>
          <p className="text-sm text-text-muted">
            Post this team&apos;s issue, comment and project update activity to
            Slack or Discord channels.
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setForm({ mode: 'create' });
          }}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          Add channel
        </Button>
      </div>

      {slack?.configured === true && (
        <SlackConnectionRow
          workspaceId={workspaceId}
          teamId={teamId}
          connection={slack}
          canManageWorkspace={canManageWorkspace}
          onDisconnected={onSlackDisconnected}
        />
      )}

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the channels.')}
        />
      )}
      {toggleError !== null && (
        <ErrorAlert
          message={errorMessage(toggleError, 'Could not change that channel.')}
        />
      )}
      {testError !== null && (
        <ErrorAlert
          message={errorMessage(testError, 'Could not send a test message.')}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading channels" />
      ) : data.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-text-muted">No channels yet.</p>
          <p className="mt-1 text-xs text-text-faint">
            {slackInstalled
              ? 'Add a Slack channel, or a Slack or Discord incoming webhook, to post issue and project update activity there.'
              : 'Add a Slack incoming webhook or a Discord channel webhook to post issue and project update activity there.'}
          </p>
        </div>
      ) : (
        <ul className="rounded-md border border-line">
          {data.map((channel) => {
            const name = channelName(channel);
            const result =
              outcome?.channelId === channel.channel_id ? outcome.result : null;
            return (
              <li
                key={channel.channel_id}
                className="border-b border-line last:border-b-0"
              >
                <div className="flex min-h-row items-center gap-3 px-3 py-2 transition-colors duration-100 hover:bg-surface">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">
                        {name}
                      </span>
                      <Badge tone="neutral">
                        {channel.transport === 'slack_app'
                          ? 'Slack app'
                          : PROVIDER_LABELS[channel.provider]}
                      </Badge>
                      {!channel.enabled && (
                        <Badge
                          tone={
                            channel.disabled_reason === null
                              ? 'neutral'
                              : 'danger'
                          }
                        >
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-text-muted">
                      {channel.url_hint}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
                      <span>{channelEventsLabel(channel.events)}</span>
                      <span aria-hidden="true">·</span>
                      {channel.last_status === null ? (
                        <span>No messages yet</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          Last message
                          <Badge tone={statusCodeTone(channel.last_status)}>
                            {statusCodeLabel(channel.last_status)}
                          </Badge>
                          {channel.last_delivery_at !== null && (
                            <RelativeTime value={channel.last_delivery_at} />
                          )}
                        </span>
                      )}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Enable ${name}`}
                    checked={channel.enabled}
                    onChange={(event) => {
                      setEnabled(channel, event.target.checked);
                    }}
                    className="h-4 w-7 shrink-0 cursor-pointer accent-accent"
                  />
                  <Menu
                    label={`${name} actions`}
                    align="end"
                    trigger={(props) => (
                      <IconButton
                        label={`${name} actions`}
                        size="sm"
                        {...props}
                      >
                        <LuEllipsis className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  >
                    <MenuItem
                      onSelect={() => {
                        setForm({ mode: 'edit', channel });
                      }}
                    >
                      <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                      Edit
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        onTest(channel);
                      }}
                    >
                      <LuSend aria-hidden="true" className="h-3.5 w-3.5" />
                      Send test message
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={() => {
                        setRemoving(channel);
                      }}
                    >
                      <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      Delete
                    </MenuItem>
                  </Menu>
                </div>

                {result !== null && (
                  <div
                    role="status"
                    className="border-t border-line px-3 py-2 text-xs text-text-muted"
                  >
                    {result.delivered
                      ? `Test message delivered to ${name}.`
                      : `Test message was not delivered (${statusCodeLabel(result.status_code)})${
                          result.error === null ? '.' : `: ${result.error}`
                        }`}
                  </div>
                )}

                {channel.disabled_reason !== null && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 border-t border-line bg-warning-soft px-3 py-2 text-xs text-warning"
                  >
                    <LuTriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-medium">Turned off automatically</p>
                      <p>
                        {channel.disabled_reason}
                        {channel.disabled_at === null
                          ? ''
                          : ` Switched off ${fullTimestamp(channel.disabled_at)}.`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEnabled(channel, true);
                      }}
                    >
                      Re-enable
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {form !== null && (
        <ChannelFormDialog
          workspaceId={workspaceId}
          teamId={teamId}
          slackInstalled={slackInstalled}
          {...(form.mode === 'edit' ? { channel: form.channel } : {})}
          saving={form.mode === 'edit' ? saving : creating}
          error={form.mode === 'edit' ? saveError : createError}
          onSave={onSave}
          onClose={() => {
            setForm(null);
          }}
        />
      )}

      <Dialog
        open={removing !== null}
        onClose={() => {
          if (!deleting) setRemoving(null);
        }}
        title="Delete channel?"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {removing === null ? 'This channel' : channelName(removing)} stops
            receiving this team&apos;s notifications. This cannot be undone.
          </p>
          {removing !== null && removeError !== null && (
            <ErrorAlert
              message={errorMessage(
                removeError,
                'Could not delete that channel.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setRemoving(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" disabled={deleting} onClick={onRemove}>
              {deleting ? 'Deleting' : 'Delete channel'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

/** Lists and manages the Slack and Discord channels of one team. */
export const TeamChannelsSection: React.FC<TeamChannelsSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
  canManageWorkspace = false,
}) => {
  if (!canEdit) {
    return (
      <section className="space-y-1">
        <h3 className="text-base font-semibold">Notifications</h3>
        <p className="text-sm text-text-muted">
          Only a team admin can manage this team&apos;s Slack and Discord
          channels.
        </p>
      </section>
    );
  }
  return (
    <ChannelsPanel
      workspaceId={workspaceId}
      teamId={teamId}
      canManageWorkspace={canManageWorkspace}
    />
  );
};

export default TeamChannelsSection;
