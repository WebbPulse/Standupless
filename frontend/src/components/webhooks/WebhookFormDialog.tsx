/**
 * The create and edit form for one webhook, in a dialog: label, URL, the team
 * it listens to when the workspace is choosing, the resource types it
 * receives and whether it is enabled.
 *
 * The form is mounted fresh each time it opens, so its fields start from the
 * webhook being edited, or from the defaults, rather than from whatever was
 * typed last time. A refused URL comes back as the server's own sentence and is
 * shown inside the dialog, beside the fields that caused it.
 */

import React, { useState } from 'react';
import { errorMessage } from '../../lib/errors';
import {
  WEBHOOK_RESOURCE_TYPES,
  type TeamRead,
  type WebhookEndpointCreate,
  type WebhookEndpointRead,
  type WebhookResourceType,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Dialog from '../ui/dialog';
import Field from '../ui/field';
import { SelectField } from '../ui/select';
import { RESOURCE_TYPE_LABELS } from './webhookDisplay';

/** The longest label the API accepts. */
export const LABEL_MAX = 80;

/** Props for WebhookFormDialog. */
export interface WebhookFormDialogProps {
  /** The webhook being edited, or undefined for a new one. */
  webhook?: WebhookEndpointRead;
  /** The teams to choose from, or undefined when the team is fixed. */
  teams?: readonly TeamRead[];
  /** Whether the save is in flight. */
  saving: boolean;
  /** The last refusal, shown inside the dialog. */
  error: unknown;
  /** Sends the form, rejecting on refusal so the dialog stays open. */
  onSave: (body: WebhookEndpointCreate) => Promise<void>;
  onClose: () => void;
}

/** A dialog that creates or edits one webhook. */
export const WebhookFormDialog: React.FC<WebhookFormDialogProps> = ({
  webhook,
  teams,
  saving,
  error,
  onSave,
  onClose,
}) => {
  const editing = webhook !== undefined;
  const [label, setLabel] = useState(webhook?.label ?? '');
  const [url, setUrl] = useState(webhook?.url ?? '');
  const [teamId, setTeamId] = useState(webhook?.team_id ?? '');
  const [types, setTypes] = useState<WebhookResourceType[]>(
    webhook?.resource_types ?? [...WEBHOOK_RESOURCE_TYPES]
  );
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);

  const trimmedLabel = label.trim();
  const canSubmit =
    trimmedLabel !== '' &&
    trimmedLabel.length <= LABEL_MAX &&
    url.trim() !== '' &&
    types.length > 0 &&
    !saving;

  const toggleType = (type: WebhookResourceType): void => {
    setTypes((current) =>
      current.includes(type)
        ? current.filter((item) => item !== type)
        : [...current, type]
    );
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void onSave({
      url: url.trim(),
      label: trimmedLabel,
      resource_types: WEBHOOK_RESOURCE_TYPES.filter((type) =>
        types.includes(type)
      ),
      enabled,
      ...(teams === undefined
        ? {}
        : { team_id: teamId === '' ? null : teamId }),
    }).catch(() => undefined);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Edit webhook' : 'New webhook'}
      description="Standupless sends a signed POST request to this URL whenever a subscribed resource changes."
    >
      <form className="space-y-4" onSubmit={onSubmit}>
        {error !== null && error !== undefined && (
          <ErrorAlert
            message={errorMessage(
              error,
              editing
                ? 'Could not save the webhook.'
                : 'Could not create the webhook.'
            )}
          />
        )}

        <Field
          id="webhook-label"
          label="Label"
          value={label}
          maxLength={LABEL_MAX}
          autoComplete="off"
          placeholder="Deploy notifier"
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />

        <Field
          id="webhook-url"
          label="URL"
          type="url"
          value={url}
          autoComplete="off"
          placeholder="https://example.com/webhooks/standupless"
          hint="A public HTTPS address. Private and loopback addresses are refused."
          className="[&_input]:font-mono"
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />

        {teams !== undefined && (
          <SelectField
            id="webhook-team"
            label="Team"
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
            }}
          >
            <option value="">All teams</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </SelectField>
        )}

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-medium text-text-muted">
            Data change events
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {WEBHOOK_RESOURCE_TYPES.map((type) => (
              <Checkbox
                key={type}
                label={RESOURCE_TYPE_LABELS[type]}
                checked={types.includes(type)}
                onChange={() => {
                  toggleType(type);
                }}
              />
            ))}
          </div>
          {types.length === 0 && (
            <p className="text-xs text-text-faint">
              Choose at least one resource type.
            </p>
          )}
        </fieldset>

        <label className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
          <span className="space-y-0.5">
            <span className="block text-sm text-text">Enabled</span>
            <span className="block text-xs text-text-muted">
              A disabled webhook keeps its settings and receives nothing.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
            className="h-4 w-7 cursor-pointer accent-accent"
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {saving
              ? editing
                ? 'Saving'
                : 'Creating'
              : editing
                ? 'Save webhook'
                : 'Create webhook'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

export default WebhookFormDialog;
