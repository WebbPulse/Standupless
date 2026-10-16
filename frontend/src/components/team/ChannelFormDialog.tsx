/**
 * The add and edit form for one Slack or Discord channel, in a dialog: where it
 * posts, a label, and the events the channel receives. A workspace channel also
 * picks the teams it follows.
 *
 * With the Slack App or the Discord App installed a new channel can post
 * through its bot to a channel picked by name from a filterable list, which is
 * the default; otherwise, or by choice, a team channel posts through an
 * incoming webhook URL. A workspace channel always posts through an App. A
 * channel a bot posts to has no URL, so its edit offers only the label, events
 * and, for a workspace channel, the teams.
 *
 * The stored URL is never sent back, so the URL field starts empty on an edit
 * and is sent only when something is typed into it, which replaces the stored
 * one. A refused URL comes back as the server's own sentence and is shown
 * inside the dialog.
 */

import React, { useMemo, useState } from 'react';
import { LuChevronDown } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listDiscordChannels, listSlackChannels } from '../../api/integrations';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { discordChannelsKey, slackChannelsKey } from '../../lib/queryKeys';
import {
  CHANNEL_EVENTS,
  type ChannelCreate,
  type ChannelEvent,
  type ChannelRead,
  type ChannelTransport,
  type ChannelUpdate,
  type TeamRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import { Combobox, type ComboboxOption } from '../ui/combobox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import Label from '../ui/label';
import Popover from '../ui/popover';
import { Skeleton } from '../ui/skeleton';
import { CHANNEL_EVENT_LABELS, CHANNEL_LABEL_MAX } from './channelDisplay';

/** The fields a new channel names the App channel it posts to with. */
type AppChannelFields =
  | 'slack_channel_id'
  | 'slack_channel_name'
  | 'discord_channel_id'
  | 'discord_channel_name';

/**
 * What the form sends: an edit, or a new channel's webhook URL, Slack channel
 * or Discord channel, and for a workspace channel the teams it follows.
 */
export type ChannelFormBody = ChannelUpdate &
  Pick<ChannelCreate, AppChannelFields> & { team_ids?: string[] };

/** How often an App's channel list is re-read while the form is open. */
const APP_CHANNELS_POLL_MS = 300000;

/** How each destination reads in the choice. */
const TRANSPORT_LABELS: Record<ChannelTransport, string> = {
  slack_app: 'Slack app',
  discord_app: 'Discord app',
  webhook: 'Incoming webhook',
};

/** One channel an App's bot can post to, as the picker lists it. */
interface AppChannel {
  id: string;
  name: string;
  is_private?: boolean;
}

/** The part of an App's channel list query the picker reads. */
interface AppChannelsQuery {
  data: AppChannel[] | null;
  error: unknown;
  isLoading: boolean;
}

/** The order the destinations are offered in. */
const TRANSPORT_ORDER: ChannelTransport[] = [
  'slack_app',
  'discord_app',
  'webhook',
];

/** What the dialog says it posts to, given the Apps it can post through. */
const describe = (slack: boolean, discord: boolean): string =>
  slack && discord
    ? "Post this team's notifications to a Slack or Discord channel through its app, or through its incoming webhook."
    : slack
      ? "Post this team's notifications to a Slack channel through the Slack app, or to a Slack or Discord channel through its incoming webhook."
      : discord
        ? "Post this team's notifications to a Discord channel through the Discord app, or to a Slack or Discord channel through its incoming webhook."
        : "Post this team's notifications to a Slack or Discord channel through its incoming webhook.";

/** What the dialog says a workspace channel posts. */
const WORKSPACE_DESCRIPTION =
  'Post notifications from every open team, or the teams you pick, to one Slack or Discord channel through its app.';

/** Props for AppChannelPicker. */
interface AppChannelPickerProps {
  id: string;
  service: string;
  query: AppChannelsQuery;
  value: string;
  onChange: (channelId: string) => void;
}

/**
 * The App channel control: a chip naming the picked channel that opens a
 * filterable list, picked by mouse or keyboard. While the first read is in
 * flight a placeholder bar holds its place.
 */
const AppChannelPicker: React.FC<AppChannelPickerProps> = ({
  id,
  service,
  query,
  value,
  onChange,
}) => {
  const channels = query.data;
  const picked = (channels ?? []).find((item) => item.id === value);
  const options: ComboboxOption[] = useMemo(
    () =>
      (channels ?? []).map((item) => ({
        value: item.id,
        label: `#${item.name}`,
        ...(item.is_private === true ? { detail: 'Private' } : {}),
      })),
    [channels]
  );
  const label = `${service} channel`;
  if (channels === null) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium text-text-muted">{label}</p>
        <div
          id={id}
          role="status"
          aria-busy={query.isLoading}
          aria-label={`Loading ${service} channels`}
          className="flex h-8 items-center rounded-sm border border-line px-2.5"
        >
          <Skeleton className="h-3 w-32" />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Popover
        label={label}
        block
        contentClassName="w-72"
        trigger={(trigger) => (
          <button
            type="button"
            id={id}
            aria-label={`${label}: ${picked === undefined ? 'none' : `#${picked.name}`}`}
            {...trigger}
            className={cn(
              'inline-flex h-8 w-full items-center justify-between gap-2 rounded-sm border border-line-strong bg-bg px-2.5 text-sm',
              'hover:border-text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent',
              picked === undefined ? 'text-text-faint' : 'text-text'
            )}
          >
            <span className="truncate">
              {picked === undefined ? 'Choose a channel' : `#${picked.name}`}
            </span>
            <LuChevronDown
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-text-faint"
            />
          </button>
        )}
      >
        {(close) => (
          <Combobox
            label={label}
            placeholder="Search channels"
            emptyMessage="No channels match"
            options={options}
            selected={value === '' ? [] : [value]}
            onSelect={(next) => {
              close();
              onChange(next);
            }}
          />
        )}
      </Popover>
    </div>
  );
};

/** What the teams chip reads for the teams a workspace channel follows. */
const followedLabel = (
  teamIds: readonly string[],
  teams: readonly TeamRead[]
): string => {
  if (teamIds.length === 0) return 'All open teams';
  const names = teamIds.map(
    (teamId) => teams.find((team) => team.id === teamId)?.name ?? 'A team'
  );
  return names.length <= 2
    ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} and ${String(names.length - 2)} more`;
};

/** Props for TeamsPicker. */
interface TeamsPickerProps {
  teams: readonly TeamRead[];
  value: string[];
  onChange: (teamIds: string[]) => void;
}

/**
 * The teams a workspace channel follows: a chip that opens a filterable list
 * where several teams can be ticked. None ticked follows every open team.
 */
const TeamsPicker: React.FC<TeamsPickerProps> = ({
  teams,
  value,
  onChange,
}) => {
  const options: ComboboxOption[] = useMemo(
    () =>
      teams.map((team) => ({
        value: team.id,
        label: team.name,
        detail: team.private === true ? 'Private' : team.key_prefix,
        keywords: [team.key_prefix],
      })),
    [teams]
  );
  const label = followedLabel(value, teams);
  return (
    <div className="space-y-1">
      <Label htmlFor="channel-teams">Teams</Label>
      <div className="flex items-center gap-2">
        <Popover
          label="Teams"
          contentClassName="w-64"
          trigger={(trigger) => (
            <button
              type="button"
              id="channel-teams"
              aria-label={`Teams: ${label}`}
              {...trigger}
              className={cn(
                'inline-flex h-7 max-w-full items-center gap-1.5 truncate rounded-sm border border-line px-2 text-sm',
                'hover:border-line-strong hover:bg-raised',
                value.length === 0 ? 'text-text-muted' : 'text-text'
              )}
            >
              {label}
            </button>
          )}
        >
          <Combobox
            label="Teams"
            placeholder="Search teams"
            emptyMessage="No teams match"
            multiple
            options={options}
            selected={value}
            onSelect={(teamId) => {
              onChange(
                value.includes(teamId)
                  ? value.filter((item) => item !== teamId)
                  : [...value, teamId]
              );
            }}
          />
        </Popover>
        {value.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onChange([]);
            }}
          >
            Follow all
          </Button>
        )}
      </div>
      <p className="text-xs text-text-faint">
        With no team picked the channel follows every open team, including teams
        added later. A private team posts here only when it is picked.
      </p>
    </div>
  );
};

/** Props for ChannelFormDialog. */
export interface ChannelFormDialogProps {
  workspaceId: string;
  /** The team the channel belongs to, or null for a workspace channel. */
  teamId: string | null;
  /** The channel being edited, or undefined for a new one. */
  channel?: ChannelRead;
  /** Whether the workspace installed the Slack App, which offers it as a destination. */
  slackInstalled?: boolean;
  /** Whether the workspace installed the Discord App, which offers it as a destination. */
  discordInstalled?: boolean;
  /** The workspace's teams, which a workspace channel picks from. */
  teams?: readonly TeamRead[];
  /** Whether the save is in flight. */
  saving: boolean;
  /** The last refusal, shown inside the dialog. */
  error: unknown;
  /** Sends the form, rejecting on refusal so the dialog stays open. */
  onSave: (body: ChannelFormBody) => Promise<void>;
  onClose: () => void;
}

/** A dialog that adds or edits one team or workspace channel. */
export const ChannelFormDialog: React.FC<ChannelFormDialogProps> = ({
  workspaceId,
  teamId,
  channel,
  slackInstalled = false,
  discordInstalled = false,
  teams = [],
  saving,
  error,
  onSave,
  onClose,
}) => {
  const auth = useQueryAuth();
  const editing = channel !== undefined;
  const workspaceScope = teamId === null;
  const [label, setLabel] = useState(channel?.label ?? '');
  const [url, setUrl] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>(channel?.team_ids ?? []);
  const [events, setEvents] = useState<ChannelEvent[]>(
    channel?.events ?? [...CHANNEL_EVENTS]
  );
  const [transport, setTransport] = useState<ChannelTransport>(
    editing
      ? (channel.transport ?? 'webhook')
      : slackInstalled
        ? 'slack_app'
        : discordInstalled
          ? 'discord_app'
          : 'webhook'
  );

  const viaBot = transport !== 'webhook';
  const service = transport === 'discord_app' ? 'Discord' : 'Slack';
  const offered: Record<ChannelTransport, boolean> = {
    slack_app: slackInstalled,
    discord_app: discordInstalled,
    webhook: !workspaceScope,
  };
  const transports = TRANSPORT_ORDER.filter((item) => offered[item]);

  const slackQuery = usePolledQuery(
    ({ signal }) => listSlackChannels(workspaceId, teamId, signal),
    {
      intervalMs: APP_CHANNELS_POLL_MS,
      queryKey: slackChannelsKey(workspaceId, teamId),
      auth,
      enabled: !editing && transport === 'slack_app',
    }
  );
  const discordQuery = usePolledQuery(
    ({ signal }) => listDiscordChannels(workspaceId, teamId, signal),
    {
      intervalMs: APP_CHANNELS_POLL_MS,
      queryKey: discordChannelsKey(workspaceId, teamId),
      auth,
      enabled: !editing && transport === 'discord_app',
    }
  );
  const appQuery: AppChannelsQuery =
    transport === 'discord_app' ? discordQuery : slackQuery;
  const appChannelsError = appQuery.error;
  const pickingAppChannel = !editing && viaBot;

  const picked = (appQuery.data ?? []).find((item) => item.id === pickedId);
  const trimmedUrl = url.trim();
  const hasDestination = editing
    ? true
    : viaBot
      ? picked !== undefined
      : trimmedUrl !== '';
  const canSubmit =
    label.trim().length <= CHANNEL_LABEL_MAX &&
    hasDestination &&
    events.length > 0 &&
    !saving;
  const labelPlaceholder = viaBot
    ? picked !== undefined
      ? `Defaults to #${picked.name}`
      : editing
        ? `Defaults to ${channel.url_hint}`
        : 'Defaults to the channel name'
    : 'Optional, such as Release alerts';

  const toggleEvent = (event: ChannelEvent): void => {
    setEvents((current) =>
      current.includes(event)
        ? current.filter((item) => item !== event)
        : [...current, event]
    );
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const destination: ChannelFormBody =
      viaBot && picked !== undefined
        ? transport === 'discord_app'
          ? { discord_channel_id: picked.id, discord_channel_name: picked.name }
          : { slack_channel_id: picked.id, slack_channel_name: picked.name }
        : !viaBot && trimmedUrl !== ''
          ? { url: trimmedUrl }
          : {};
    void onSave({
      label: label.trim(),
      events: CHANNEL_EVENTS.filter((item) => events.includes(item)),
      ...destination,
      ...(workspaceScope ? { team_ids: teamIds } : {}),
    }).catch(() => undefined);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit channel' : 'Add channel'}
      description={
        workspaceScope
          ? WORKSPACE_DESCRIPTION
          : describe(
              slackInstalled || transport === 'slack_app',
              discordInstalled || transport === 'discord_app'
            )
      }
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {error !== null && error !== undefined && (
          <ErrorAlert
            message={errorMessage(
              error,
              editing
                ? 'Could not save the channel.'
                : 'Could not add the channel.'
            )}
          />
        )}

        {!editing && transports.length > 1 && (
          <div
            role="radiogroup"
            aria-label="Destination"
            className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg p-0.5"
          >
            {transports.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={transport === item}
                onClick={() => {
                  setTransport(item);
                  setPickedId('');
                }}
                className={cn(
                  'inline-flex h-6 items-center rounded-sm px-2 text-xs transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
                  transport === item
                    ? 'bg-raised text-text'
                    : 'text-text-muted hover:bg-surface hover:text-text'
                )}
              >
                {TRANSPORT_LABELS[item]}
              </button>
            ))}
          </div>
        )}

        {pickingAppChannel && (
          <div className="space-y-1">
            {appChannelsError !== null && (
              <ErrorAlert
                message={errorMessage(
                  appChannelsError,
                  `Could not load the ${service} channels.`
                )}
              />
            )}
            <AppChannelPicker
              key={transport}
              id={`channel-${transport}`}
              service={service}
              query={appQuery}
              value={pickedId}
              onChange={setPickedId}
            />
            <p className="text-xs text-text-faint">
              {transport === 'discord_app'
                ? 'Text and announcement channels in the Discord server. The Standupless bot needs permission to send messages in the one you pick.'
                : 'Public channels, and private channels the Standupless app was invited to. Invite it in Slack to post to a private one.'}
            </p>
          </div>
        )}

        {editing && viaBot && (
          <p className="text-sm text-text-muted">
            Posts to{' '}
            <span className="font-mono text-text">{channel.url_hint}</span>{' '}
            through the {service} app. To post somewhere else, add a new
            channel.
          </p>
        )}

        {!viaBot && (
          <Field
            id="channel-url"
            label="Webhook URL"
            type="url"
            value={url}
            autoComplete="off"
            placeholder={
              editing
                ? `Current: ${channel.url_hint}`
                : 'https://hooks.slack.com/services/...'
            }
            hint={
              editing
                ? 'Leave empty to keep the current URL. It is stored encrypted and never shown again.'
                : 'A Slack incoming webhook or a Discord channel webhook. It is stored encrypted and never shown again.'
            }
            className="[&_input]:font-mono"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
        )}

        {workspaceScope && (
          <TeamsPicker teams={teams} value={teamIds} onChange={setTeamIds} />
        )}

        <Field
          id="channel-label"
          label="Label"
          value={label}
          maxLength={CHANNEL_LABEL_MAX}
          autoComplete="off"
          placeholder={labelPlaceholder}
          className="[&_input]:placeholder:italic"
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-text-muted">
            Events
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {CHANNEL_EVENTS.map((item) => (
              <Checkbox
                key={item}
                label={CHANNEL_EVENT_LABELS[item]}
                checked={events.includes(item)}
                onChange={() => {
                  toggleEvent(item);
                }}
              />
            ))}
          </div>
          {events.length === 0 && (
            <p className="text-xs text-text-faint">
              Choose at least one event.
            </p>
          )}
        </fieldset>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {saving
              ? editing
                ? 'Saving'
                : 'Adding'
              : editing
                ? 'Save channel'
                : 'Add channel'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default ChannelFormDialog;
