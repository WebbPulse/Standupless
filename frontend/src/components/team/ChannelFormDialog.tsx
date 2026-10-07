/**
 * The add and edit form for one Slack or Discord channel, in a dialog: the
 * incoming webhook URL, a label, and the events the channel receives.
 *
 * The stored URL is never sent back, so the URL field starts empty on an edit
 * and is sent only when something is typed into it, which replaces the stored
 * one. A refused URL comes back as the server's own sentence and is shown
 * inside the dialog.
 */

import React, { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import {
  CHANNEL_EVENTS,
  type ChannelEvent,
  type ChannelRead,
  type ChannelUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';

/** The longest label the API accepts. */
export const CHANNEL_LABEL_MAX = 80;

/** How each event reads in the form and the list. */
export const CHANNEL_EVENT_LABELS: Record<ChannelEvent, string> = {
  issue_created: 'Issue created',
  issue_status_changed: 'Status changed',
  issue_completed: 'Issue completed',
  issue_assigned: 'Issue assigned',
  comment_created: 'New comment',
  project_update_posted: 'Project update posted',
  project_update_due: 'Project update due',
};

/** A channel's events as one line, in the order the form lists them. */
export const channelEventsLabel = (events: readonly ChannelEvent[]): string =>
  events.length === CHANNEL_EVENTS.length
    ? 'All events'
    : CHANNEL_EVENTS.filter((event) => events.includes(event))
        .map((event) => CHANNEL_EVENT_LABELS[event])
        .join(', ');

/** Props for ChannelFormDialog. */
export interface ChannelFormDialogProps {
  /** The channel being edited, or undefined for a new one. */
  channel?: ChannelRead;
  /** Whether the save is in flight. */
  saving: boolean;
  /** The last refusal, shown inside the dialog. */
  error: unknown;
  /** Sends the form, rejecting on refusal so the dialog stays open. */
  onSave: (body: ChannelUpdate) => Promise<void>;
  onClose: () => void;
}

/** A dialog that adds or edits one team channel. */
export const ChannelFormDialog: React.FC<ChannelFormDialogProps> = ({
  channel,
  saving,
  error,
  onSave,
  onClose,
}) => {
  const editing = channel !== undefined;
  const [label, setLabel] = useState(channel?.label ?? '');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<ChannelEvent[]>(
    channel?.events ?? [...CHANNEL_EVENTS]
  );

  const trimmedUrl = url.trim();
  const canSubmit =
    label.trim().length <= CHANNEL_LABEL_MAX &&
    (editing || trimmedUrl !== '') &&
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
    void onSave({
      label: label.trim(),
      events: CHANNEL_EVENTS.filter((item) => events.includes(item)),
      ...(trimmedUrl === '' ? {} : { url: trimmedUrl }),
    }).catch(() => undefined);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit channel' : 'Add channel'}
      description="Post this team's notifications to a Slack or Discord channel through its incoming webhook."
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
            <p className="text-xs text-text-faint">Choose at least one event.</p>
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
