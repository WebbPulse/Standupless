/**
 * The Slack and Discord channels one team, or the whole workspace, posts its
 * notifications to: a list of channels with their kind, masked URL or channel
 * name, events and last response, an enabled switch and a Send test action on
 * each row, and a menu to edit or remove one.
 *
 * A write's answer is shown at once rather than waiting on the list read it
 * triggers, since a poll already in flight can land after the write with the
 * list from before it. A row the server returned stands in for the listed one
 * until the list catches up, a new row shows before the list carries it, and a
 * removed row stays hidden.
 *
 * A channel the server turned off because its webhook is gone carries a
 * warning with its own re-enable action, since the person reading the list did
 * not turn it off and may not know why it went quiet.
 */

import React, { useMemo, useState } from 'react';
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
  listChannels,
  testChannel,
  updateChannel,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { channelsKey } from '../../lib/queryKeys';
import { fullTimestamp } from '../../lib/relativeTime';
import type {
  ChannelCreate,
  ChannelProvider,
  ChannelRead,
  ChannelTestRead,
  ChannelTransport,
  ChannelUpdate,
  TeamRead,
  WorkspaceChannelCreate,
  WorkspaceChannelUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { statusCodeLabel, statusCodeTone } from '../webhooks/webhookDisplay';
import ChannelFormDialog, { type ChannelFormBody } from './ChannelFormDialog';
import { channelEventsLabel } from './channelDisplay';

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** How each provider reads in the list. */
const PROVIDER_LABELS: Record<ChannelProvider, string> = {
  slack: 'Slack',
  discord: 'Discord',
};

/** How a channel a chat App's bot posts to reads in the list. */
const APP_LABELS: Record<Exclude<ChannelTransport, 'webhook'>, string> = {
  slack_app: 'Slack app',
  discord_app: 'Discord app',
};

/** What kind of channel a row is: the App its bot posts through, or its webhook's provider. */
const channelKind = (channel: ChannelRead): string =>
  channel.transport === undefined || channel.transport === 'webhook'
    ? PROVIDER_LABELS[channel.provider]
    : APP_LABELS[channel.transport];

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

/** The teams a workspace channel follows, as its row reads them. */
const followedTeams = (
  channel: ChannelRead,
  teams: readonly TeamRead[]
): string => {
  const teamIds = channel.team_ids ?? [];
  if (teamIds.length === 0) return 'All open teams';
  return teamIds
    .map(
      (teamId) =>
        teams.find((team) => team.id === teamId)?.name ??
        'A team you cannot see'
    )
    .join(', ');
};

/** What a new channel's form becomes in the create body for either scope. */
const createBody = (
  body: ChannelFormBody,
  workspaceScope: boolean
): ChannelCreate | WorkspaceChannelCreate => {
  const destination =
    body.slack_channel_id !== undefined
      ? {
          slack_channel_id: body.slack_channel_id,
          ...(body.slack_channel_name === undefined
            ? {}
            : { slack_channel_name: body.slack_channel_name }),
        }
      : body.discord_channel_id !== undefined
        ? {
            discord_channel_id: body.discord_channel_id,
            ...(body.discord_channel_name === undefined
              ? {}
              : { discord_channel_name: body.discord_channel_name }),
          }
        : { url: body.url ?? '' };
  return {
    ...destination,
    events: body.events ?? [],
    ...(body.label === undefined ? {} : { label: body.label }),
    ...(workspaceScope ? { team_ids: body.team_ids ?? [] } : {}),
  };
};

/** What an edit's form becomes in the update body for either scope. */
const updateBody = (
  body: ChannelFormBody,
  workspaceScope: boolean
): ChannelUpdate | WorkspaceChannelUpdate => ({
  ...(body.url === undefined || workspaceScope ? {} : { url: body.url }),
  ...(body.label === undefined ? {} : { label: body.label }),
  ...(body.events === undefined ? {} : { events: body.events }),
  ...(workspaceScope && body.team_ids !== undefined
    ? { team_ids: body.team_ids }
    : {}),
});

/** The rows to show: the listed ones, with every write's answer laid over them. */
const mergeRows = (
  listed: readonly ChannelRead[] | null,
  written: Readonly<Record<string, ChannelRead>>,
  removed: ReadonlySet<string>
): ChannelRead[] | null => {
  if (listed === null && Object.keys(written).length === 0) return null;
  const base = listed ?? [];
  const known = new Set(base.map((row) => row.channel_id));
  const rows = base.map((row) => {
    const newer = written[row.channel_id];
    return newer !== undefined && newer.updated_at > row.updated_at
      ? newer
      : row;
  });
  const added = Object.values(written)
    .filter((row) => !known.has(row.channel_id))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return [...rows, ...added].filter((row) => !removed.has(row.channel_id));
};

/** Props for ChannelsPanel. */
export interface ChannelsPanelProps {
  workspaceId: string;
  /** The team whose channels these are, or null for the workspace's own. */
  teamId: string | null;
  /** Whether the workspace installed the Slack App. */
  slackInstalled: boolean;
  /** Whether the workspace installed the Discord App. */
  discordInstalled: boolean;
  /** The workspace's teams, which workspace channels follow and name. */
  teams?: readonly TeamRead[];
  /** The section heading. */
  title: string;
  /** The sentence under the heading. */
  description: string;
  /** What the empty list suggests. */
  emptyHint: string;
  /** Why a new channel cannot be added yet, which disables the button. */
  addBlockedReason?: string;
  /** What sits between the heading and the list, such as the chat App connections. */
  children?: React.ReactNode;
}

/** The channels list with its add, edit, test and remove actions. */
export const ChannelsPanel: React.FC<ChannelsPanelProps> = ({
  workspaceId,
  teamId,
  slackInstalled,
  discordInstalled,
  teams = [],
  title,
  description,
  emptyHint,
  addBlockedReason,
  children,
}) => {
  const auth = useQueryAuth();
  const workspaceScope = teamId === null;
  const queryKey = channelsKey(workspaceId, teamId);
  const [form, setForm] = useState<FormState | null>(null);
  const [removing, setRemoving] = useState<ChannelRead | null>(null);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [written, setWritten] = useState<Record<string, ChannelRead>>({});
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listChannels(workspaceId, teamId, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const rows = useMemo(
    () => mergeRows(isLoading ? null : data, written, removed),
    [data, isLoading, written, removed]
  );

  const remember = (row: ChannelRead): void => {
    setWritten((current) => ({ ...current, [row.channel_id]: row }));
  };

  const {
    mutate: create,
    isMutating: creating,
    error: createError,
  } = useMutationWithRefetch(
    (body: ChannelFormBody) =>
      createChannel(workspaceId, teamId, createBody(body, workspaceScope)),
    queryKey
  );

  const {
    mutate: save,
    isMutating: saving,
    error: saveError,
  } = useMutationWithRefetch(
    (input: { channelId: string; body: ChannelFormBody }) =>
      updateChannel(
        workspaceId,
        teamId,
        input.channelId,
        updateBody(input.body, workspaceScope)
      ),
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
    const row =
      form?.mode === 'edit'
        ? await save({ channelId: form.channel.channel_id, body })
        : await create(body);
    remember(row);
    setForm(null);
  };

  const onTest = (channel: ChannelRead): void => {
    setOutcome(null);
    setTesting(channel.channel_id);
    void sendTest(channel.channel_id)
      .then((result) => {
        setOutcome({ channelId: channel.channel_id, result });
      })
      .catch(() => undefined)
      .finally(() => {
        setTesting(null);
      });
  };

  const onRemove = (): void => {
    if (removing === null) return;
    const { channel_id: channelId } = removing;
    void remove(channelId)
      .then(() => {
        setRemoved((current) => new Set([...current, channelId]));
        setRemoving(null);
        if (outcome?.channelId === channelId) setOutcome(null);
      })
      .catch(() => undefined);
  };

  const setEnabled = (channel: ChannelRead, enabled: boolean): void => {
    void toggle({ channelId: channel.channel_id, enabled })
      .then(remember)
      .catch(() => undefined);
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          disabled={addBlockedReason !== undefined}
          title={addBlockedReason}
          onClick={() => {
            setForm({ mode: 'create' });
          }}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          Add channel
        </Button>
      </div>

      {children}

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

      {rows === null ? (
        <div
          role="status"
          aria-busy="true"
          aria-label="Loading channels"
          className="rounded-md border border-line"
        >
          {[0, 1].map((index) => (
            <div
              key={index}
              className="flex min-h-row items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton
                  className={index === 0 ? 'h-3.5 w-40' : 'h-3.5 w-28'}
                />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-7 w-20" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-text-muted">No channels yet.</p>
          <p className="mt-1 text-xs text-text-faint">{emptyHint}</p>
        </div>
      ) : (
        <ul className="rounded-md border border-line">
          {rows.map((channel) => {
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
                      <Badge tone="neutral">{channelKind(channel)}</Badge>
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
                    {workspaceScope && (
                      <p className="truncate text-xs text-text-muted">
                        {followedTeams(channel, teams)}
                      </p>
                    )}
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
                  <Button
                    size="sm"
                    aria-label={`Send a test message to ${name}`}
                    disabled={testing === channel.channel_id}
                    onClick={() => {
                      onTest(channel);
                    }}
                  >
                    <LuSend aria-hidden="true" className="h-3.5 w-3.5" />
                    {testing === channel.channel_id ? 'Sending' : 'Send test'}
                  </Button>
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
          discordInstalled={discordInstalled}
          teams={teams}
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
            receiving{' '}
            {workspaceScope
              ? 'notifications from the workspace'
              : 'this team’s notifications'}
            . This cannot be undone.
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

export default ChannelsPanel;
