/**
 * The add and edit form for one Slack or Discord channel, in a dialog: where it
 * posts, a label, and the events the channel receives.
 *
 * With the Slack App or the Discord App installed a new channel can post
 * through its bot to a channel picked by name, which is the default; otherwise,
 * or by choice, it posts through an incoming webhook URL. A channel a bot posts
 * to has no URL, so its edit offers only the label and events.
 *
 * The stored URL is never sent back, so the URL field starts empty on an edit
 * and is sent only when something is typed into it, which replaces the stored
 * one. A refused URL comes back as the server's own sentence and is shown
 * inside the dialog.
 */

import React, { useState } from 'react';
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
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { SelectField } from '../ui/select';
import { CHANNEL_EVENT_LABELS, CHANNEL_LABEL_MAX } from './channelDisplay';

/** The fields a new channel names the App channel it posts to with. */
type AppChannelFields =
  | 'slack_channel_id'
  | 'slack_channel_name'
  | 'discord_channel_id'
  | 'discord_channel_name';

/** What the form sends: an edit, or a new channel's webhook URL, Slack channel or Discord channel. */
export type ChannelFormBody = ChannelUpdate &
  Pick<ChannelCreate, AppChannelFields>;

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

/** Props for ChannelFormDialog. */
export interface ChannelFormDialogProps {
  workspaceId: string;
  teamId: string;
  /** The channel being edited, or undefined for a new one. */
  channel?: ChannelRead;
  /** Whether the workspace installed the Slack App, which offers it as a destination. */
  slackInstalled?: boolean;
  /** Whether the workspace installed the Discord App, which offers it as a destination. */
  discordInstalled?: boolean;
  /** Whether the save is in flight. */
  saving: boolean;
  /** The last refusal, shown inside the dialog. */
  error: unknown;
  /** Sends the form, rejecting on refusal so the dialog stays open. */
  onSave: (body: ChannelFormBody) => Promise<void>;
  onClose: () => void;
}

/** A dialog that adds or edits one team channel. */
export const ChannelFormDialog: React.FC<ChannelFormDialogProps> = ({
  workspaceId,
  teamId,
  channel,
  slackInstalled = false,
  discordInstalled = false,
  saving,
  error,
  onSave,
  onClose,
}) => {
  const auth = useQueryAuth();
  const editing = channel !== undefined;
  const [label, setLabel] = useState(channel?.label ?? '');
  const [url, setUrl] = useState('');
  const [pickedId, setPickedId] = useState('');
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
    webhook: true,
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
  const appChannels = appQuery.data;
  const appChannelsError = appQuery.error;
  const loadingAppChannels = appQuery.isLoading;
  const pickingAppChannel = !editing && viaBot;

  const picked = (appChannels ?? []).find((item) => item.id === pickedId);
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
    }).catch(() => undefined);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit channel' : 'Add channel'}
      description={describe(
        slackInstalled || transport === 'slack_app',
        discordInstalled || transport === 'discord_app'
      )}
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
            <SelectField
              id={`channel-${transport}`}
              label={`${service} channel`}
              value={pickedId}
              disabled={loadingAppChannels || appChannels === null}
              onChange={(event) => {
                setPickedId(event.target.value);
              }}
            >
              <option value="">
                {loadingAppChannels || appChannels === null
                  ? 'Loading channels'
                  : 'Choose a channel'}
              </option>
              {(appChannels ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.is_private === true
                    ? `#${item.name} (private)`
                    : `#${item.name}`}
                </option>
              ))}
            </SelectField>
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

        <Field
          id="channel-label"
          label="Label"
          value={label}
          maxLength={CHANNEL_LABEL_MAX}
          autoComplete="off"
          placeholder="#eng-updates"
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
