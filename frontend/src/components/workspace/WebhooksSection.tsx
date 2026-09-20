/**
 * The outbound webhook endpoints of one workspace.
 *
 * The signing secret is returned by the create and rotate calls and by nothing
 * else, so it is held in state and shown until dismissed, the same way a new
 * invite's token is. A rotate takes effect at once and there is no overlap
 * window, so the copy says so rather than letting somebody discover it from
 * failed deliveries.
 */

import React, { useState } from 'react';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  rotateWebhookSecret,
  updateWebhook,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { webhooksKey } from '../../lib/queryKeys';
import {
  OUTBOUND_EVENTS,
  type OutboundEvent,
  type WebhookEndpointRead,
  type WorkspaceRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import Checkbox from '../ui/checkbox';
import Field from '../ui/field';
import Spinner from '../ui/spinner';

/** Props for WebhooksSection: the workspace whose endpoints are shown. */
export interface WebhooksSectionProps {
  workspace: WorkspaceRead;
}

/** How often the endpoint list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** How one event name reads in the interface. */
const eventLabel = (event: string): string => event.replace('.', ' ');

/** The column layout the header and every row share. */
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3';

/** Lists and creates webhook endpoints, and shows a new secret once. */
export const WebhooksSection: React.FC<WebhooksSectionProps> = ({
  workspace,
}) => {
  const auth = useQueryAuth();
  const queryKey = webhooksKey(workspace.id);
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<OutboundEvent[]>([...OUTBOUND_EVENTS]);
  const [revealed, setRevealed] = useState<WebhookEndpointRead | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWebhooks(workspace.id, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: create,
    isMutating,
    error: createError,
  } = useMutationWithRefetch(
    (body: { url: string; events: string[]; description?: string }) =>
      createWebhook(workspace.id, body),
    queryKey
  );

  const { mutate: rotate, error: rotateError } = useMutationWithRefetch(
    (webhookId: string) => rotateWebhookSecret(workspace.id, webhookId),
    queryKey
  );

  const { mutate: toggle, error: toggleError } = useMutationWithRefetch(
    (input: { webhookId: string; active: boolean }) =>
      updateWebhook(workspace.id, input.webhookId, { active: input.active }),
    queryKey
  );

  const { mutate: remove, error: removeError } = useMutationWithRefetch(
    (webhookId: string) => deleteWebhook(workspace.id, webhookId),
    queryKey
  );

  const canSubmit = url.trim() !== '' && events.length > 0 && !isMutating;

  const reveal = (endpoint: WebhookEndpointRead): void => {
    setRevealed(endpoint);
    setCopied(false);
  };

  const onSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    const trimmed = description.trim();
    void create({
      url: url.trim(),
      events: [...events],
      ...(trimmed === '' ? {} : { description: trimmed }),
    })
      .then((result) => {
        reveal(result);
        setUrl('');
        setDescription('');
        setEvents([...OUTBOUND_EVENTS]);
      })
      .catch(() => undefined);
  };

  const onCopy = (): void => {
    const secret = revealed?.secret;
    if (secret === null || secret === undefined) return;
    void globalThis.navigator.clipboard
      ?.writeText(secret)
      .then(() => {
        setCopied(true);
      })
      .catch(() => undefined);
  };

  const toggleEvent = (event: OutboundEvent): void => {
    setEvents((current) =>
      current.includes(event)
        ? current.filter((item) => item !== event)
        : [...current, event]
    );
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Webhooks</h2>
        <p className="text-sm text-text-muted">
          Each delivery is signed, so a receiver can check it came from this
          workspace before acting on it.
        </p>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the webhooks.')}
        />
      )}
      {rotateError !== null && (
        <ErrorAlert
          message={errorMessage(rotateError, 'Could not rotate that secret.')}
        />
      )}
      {toggleError !== null && (
        <ErrorAlert
          message={errorMessage(toggleError, 'Could not change that endpoint.')}
        />
      )}
      {removeError !== null && (
        <ErrorAlert
          message={errorMessage(removeError, 'Could not delete that endpoint.')}
        />
      )}

      {revealed !== null &&
        revealed.secret !== null &&
        revealed.secret !== undefined && (
          <div
            role="status"
            className="space-y-3 rounded-md border border-success/30 bg-success-soft p-3"
          >
            <p className="text-sm text-text">
              This signing secret for {revealed.url} is shown once, so copy it
              now. Nothing can read it again.
            </p>
            <code className="block overflow-x-auto rounded-sm border border-line bg-bg px-2 py-1 font-mono text-xs text-text">
              {revealed.secret}
            </code>
            <div className="flex gap-1.5">
              <Button variant="primary" size="sm" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy secret'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setRevealed(null);
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

      {isLoading || data === null || data === undefined ? (
        <Spinner label="Loading webhooks" />
      ) : data.length === 0 ? (
        <p className="text-sm text-text-muted">
          There are no webhook endpoints yet.
        </p>
      ) : (
        <div className="rounded-md border border-line">
          <div
            className={`${COLUMNS} h-8 border-b border-line bg-surface text-xs font-medium text-text-muted`}
          >
            <span>Endpoint</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul>
            {data.map((item) => (
              <li
                key={item.webhook_id}
                className={`${COLUMNS} min-h-row border-b border-line py-1.5 transition-colors duration-100 last:border-b-0 hover:bg-surface`}
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium text-text">
                      {item.url}
                    </span>
                    <Badge tone={item.active ? 'success' : 'neutral'}>
                      {item.active ? 'Active' : 'Paused'}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-text-muted">
                    {item.events.map(eventLabel).join(', ')}
                  </p>
                  <p className="text-xs text-text-faint">
                    secret ending {item.secret_hint}
                    {item.last_status === null
                      ? ''
                      : `, last delivery ${String(item.last_status)}`}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void toggle({
                        webhookId: item.webhook_id,
                        active: !item.active,
                      }).catch(() => undefined);
                    }}
                  >
                    {item.active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      void rotate(item.webhook_id)
                        .then(reveal)
                        .catch(() => undefined);
                    }}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      void remove(item.webhook_id).catch(() => undefined);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        className="space-y-4 rounded-md border border-line p-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-sm font-medium">Add an endpoint</h3>

        {createError !== null && (
          <ErrorAlert
            message={errorMessage(createError, 'Could not add the endpoint.')}
          />
        )}

        <div className="max-w-md space-y-4">
          <Field
            id="webhook-url"
            label="Endpoint URL"
            type="url"
            value={url}
            autoComplete="off"
            className="font-mono"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />

          <Field
            id="webhook-description"
            label="Description"
            value={description}
            autoComplete="off"
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-text-muted">
              Events
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {OUTBOUND_EVENTS.map((event) => (
                <Checkbox
                  key={event}
                  label={eventLabel(event)}
                  checked={events.includes(event)}
                  onChange={() => {
                    toggleEvent(event);
                  }}
                />
              ))}
            </div>
          </fieldset>
        </div>

        <Button type="submit" variant="primary" disabled={!canSubmit}>
          {isMutating ? 'Adding' : 'Add endpoint'}
        </Button>
      </form>
    </section>
  );
};

export default WebhooksSection;
