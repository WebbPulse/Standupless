/**
 * The add and edit form for one Slack or Discord channel, in a dialog: where it
 * posts, a label, and the events the channel receives.
 *
 * With the Slack App installed a new channel can post through its bot to a
 * channel picked by name, which is the default; otherwise, or by choice, it
 * posts through an incoming webhook URL. A channel the bot posts to has no URL,
 * so its edit offers only the label and events.
 *
 * The stored URL is never sent back, so the URL field starts empty on an edit
 * and is sent only when something is typed into it, which replaces the stored
 * one. A refused URL comes back as the server's own sentence and is shown
 * inside the dialog.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { listSlackChannels } from '../../api/integrations';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import { slackChannelsKey } from '../../lib/queryKeys';
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

/** What the form sends: an edit, or a new channel's webhook URL or Slack channel. */
export type ChannelFormBody = ChannelUpdate &
  Pick<ChannelCreate, 'slack_channel_id' | 'slack_channel_name'>;

/** How often the Slack channel list is re-read while the form is open. */
const SLACK_CHANNELS_POLL_MS = 300000;

/** How each destination reads in the choice. */
const TRANSPORT_LABELS: Record<ChannelTransport, string> = {
  slack_app: 'Slack app',
  webhook: 'Incoming webhook',
};

/** Props for ChannelFormDialog. */
export interface ChannelFormDialogProps {
  workspaceId: string;
  teamId: string;
  /** The channel being edited, or undefined for a new one. */
  channel?: ChannelRead;
  /** Whether the workspace installed the Slack App, which offers it as a destination. */
  slackInstalled?: boolean;
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
  saving,
  error,
  onSave,
  onClose,
}) => {
  const auth = useQueryAuth();
  const editing = channel !== undefined;
  const [label, setLabel] = useState(channel?.label ?? '');
  const [url, setUrl] = useState('');
  const [slackChannelId, setSlackChannelId] = useState('');
  const [events, setEvents] = useState<ChannelEvent[]>(
    channel?.events ?? [...CHANNEL_EVENTS]
  );
  const [transport, setTransport] = useState<ChannelTransport>(
    editing
      ? (channel.transport ?? 'webhook')
      : slackInstalled
        ? 'slack_app'
        : 'webhook'
  );

  const viaBot = transport === 'slack_app';
  const pickingSlackChannel = !editing && viaBot;

  const {
    data: slackChannels,
    error: slackChannelsError,
    isLoading: loadingSlackChannels,
  } = usePolledQuery(
    ({ signal }) => listSlackChannels(workspaceId, teamId, signal),
    {
      intervalMs: SLACK_CHANNELS_POLL_MS,
      queryKey: slackChannelsKey(workspaceId, teamId),
      auth,
      enabled: pickingSlackChannel,
    }
  );

  const picked = (slackChannels ?? []).find(
    (item) => item.id === slackChannelId
  );
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
        ? { slack_channel_id: picked.id, slack_channel_name: picked.name }
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
      description={
        slackInstalled || viaBot
          ? "Post this team's notifications to a Slack channel through the Slack app, or to a Slack or Discord channel through its incoming webhook."
          : "Post this team's notifications to a Slack or Discord channel through its incoming webhook."
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

        {!editing && slackInstalled && (
          <div
            role="radiogroup"
            aria-label="Destination"
            className="inline-flex items-center gap-0.5 rounded-md border border-line bg-bg p-0.5"
          >
            {(['slack_app', 'webhook'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={transport === item}
                onClick={() => {
                  setTransport(item);
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

        {pickingSlackChannel && (
          <div className="space-y-1">
            {slackChannelsError !== null && (
              <ErrorAlert
                message={errorMessage(
                  slackChannelsError,
                  'Could not load the Slack channels.'
                )}
              />
            )}
            <SelectField
              id="channel-slack"
              label="Slack channel"
              value={slackChannelId}
              disabled={loadingSlackChannels || slackChannels === null}
              onChange={(event) => {
                setSlackChannelId(event.target.value);
              }}
            >
              <option value="">
                {loadingSlackChannels || slackChannels === null
                  ? 'Loading channels'
                  : 'Choose a channel'}
              </option>
              {(slackChannels ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.is_private
                    ? `#${item.name} (private)`
                    : `#${item.name}`}
                </option>
              ))}
            </SelectField>
            <p className="text-xs text-text-faint">
              Public channels, and private channels the Standupless app was
              invited to. Invite it in Slack to post to a private one.
            </p>
          </div>
        )}

        {editing && viaBot && (
          <p className="text-sm text-text-muted">
            Posts to{' '}
            <span className="font-mono text-text">{channel.url_hint}</span>{' '}
            through the Slack app. To post somewhere else, add a new channel.
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
