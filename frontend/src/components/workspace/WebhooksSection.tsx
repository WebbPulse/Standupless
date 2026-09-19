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
import Button from '../ui/button';
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
      <h2 className="text-lg font-medium text-white">Webhooks</h2>
      <p className="text-sm text-slate-400">
        Each delivery is signed, so a receiver can check it came from this
        workspace before acting on it.
      </p>

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
            className="space-y-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3"
          >
            <p className="text-sm text-emerald-100">
              This signing secret for {revealed.url} is shown once, so copy it
              now. Nothing can read it again.
            </p>
            <code className="block overflow-x-auto rounded border border-emerald-500/30 bg-slate-900 px-2 py-1 text-xs text-emerald-200">
              {revealed.secret}
            </code>
            <div className="flex gap-2">
              <Button onClick={onCopy}>
                {copied ? 'Copied' : 'Copy secret'}
              </Button>
              <Button
                variant="secondary"
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
        <p className="text-sm text-slate-400">
          There are no webhook endpoints yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.map((item) => (
            <li
              key={item.webhook_id}
              className="space-y-2 rounded-md border border-slate-700 px-3 py-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-slate-100">{item.url}</p>
                  <p className="text-xs text-slate-500">
                    {item.active ? 'Active' : 'Paused'}, secret ending{' '}
                    {item.secret_hint}
                    {item.last_status === null
                      ? ''
                      : `, last delivery ${String(item.last_status)}`}
                  </p>
                  <p className="text-xs text-slate-500">
                    {item.events.map(eventLabel).join(', ')}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
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
                    variant="secondary"
                    onClick={() => {
                      void rotate(item.webhook_id)
                        .then(reveal)
                        .catch(() => undefined);
                    }}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      void remove(item.webhook_id).catch(() => undefined);
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="space-y-4 rounded-md border border-slate-700 p-4"
        onSubmit={onSubmit}
      >
        <h3 className="text-sm font-medium text-white">Add an endpoint</h3>

        {createError !== null && (
          <ErrorAlert
            message={errorMessage(createError, 'Could not add the endpoint.')}
          />
        )}

        <Field
          id="webhook-url"
          label="Endpoint URL"
          type="url"
          value={url}
          autoComplete="off"
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
          <legend className="text-sm text-slate-300">Events</legend>
          {OUTBOUND_EVENTS.map((event) => (
            <label
              key={event}
              className="flex items-center gap-2 text-sm text-slate-300"
            >
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={() => {
                  toggleEvent(event);
                }}
              />
              {eventLabel(event)}
            </label>
          ))}
        </fieldset>

        <Button type="submit" disabled={!canSubmit}>
          {isMutating ? 'Adding' : 'Add endpoint'}
        </Button>
      </form>
    </section>
  );
};

export default WebhooksSection;
