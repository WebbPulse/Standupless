/**
 * One webhook's delivery log: the most recent deliveries, newest first, each
 * opening to show every attempt at sending it and the payload it carried.
 *
 * The log is read while it is on screen, faster while any delivery is still
 * pending or retrying, since those change on their own as the retries run. A
 * test ping and a redelivery both add a row, so both refresh the log and the
 * webhook list, whose last status they also move.
 */

import React, { useState } from 'react';
import { LuChevronDown, LuChevronRight, LuSend } from 'react-icons/lu';
import { useQueryAuth } from '@webbpulse/auth/react';
import {
  usePolledQuery,
  useMutationWithRefetch,
} from '@webbpulse/api-client/react';
import {
  listWebhookDeliveries,
  pingWebhook,
  redeliverWebhookDelivery,
  type WebhookScope,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { fullTimestamp } from '../../lib/relativeTime';
import { webhookDeliveriesKey, webhooksKey } from '../../lib/queryKeys';
import type {
  WebhookDeliveryAttempt,
  WebhookDeliveryRead,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button from '../ui/button';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';
import {
  DELIVERY_STATES,
  deliveryEventLabel,
  isInFlight,
  statusCodeLabel,
  statusCodeTone,
} from './webhookDisplay';

/** How often a settled log is re-read. */
const IDLE_POLL_MS = 30000;

/** How often the log is re-read while a delivery is still in flight. */
const ACTIVE_POLL_MS = 3000;

/** Props for WebhookDeliveries: whose log, and the webhook it belongs to. */
export interface WebhookDeliveriesProps {
  scope: WebhookScope;
  webhookId: string;
}

/** The last attempt at a delivery, or undefined before the first one. */
const lastAttempt = (
  delivery: WebhookDeliveryRead
): WebhookDeliveryAttempt | undefined =>
  delivery.attempts[delivery.attempts.length - 1];

/** A block of preformatted text: a request or a response body. */
const Body: React.FC<{ label: string; text: string; truncated?: boolean }> = ({
  label,
  text,
  truncated = false,
}) => (
  <div className="space-y-1">
    <p className="text-2xs font-medium text-text-faint">
      {label}
      {truncated ? ' (truncated)' : ''}
    </p>
    <pre className="max-h-48 overflow-auto rounded-sm border border-line bg-bg px-2 py-1.5 font-mono text-2xs whitespace-pre-wrap break-all text-text">
      {text === '' ? 'Empty' : text}
    </pre>
  </div>
);

/** One delivery as a row that opens to its attempts and payload. */
const DeliveryRow: React.FC<{
  delivery: WebhookDeliveryRead;
  onRedeliver: (deliveryId: string) => void;
  redelivering: boolean;
}> = ({ delivery, onRedeliver, redelivering }) => {
  const [open, setOpen] = useState(false);
  const state = DELIVERY_STATES[delivery.state];
  const last = lastAttempt(delivery);
  const Chevron = open ? LuChevronDown : LuChevronRight;
  const label = deliveryEventLabel(delivery);

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex min-h-row items-center gap-2 px-3 py-1.5 transition-colors duration-100 hover:bg-surface has-[button[aria-expanded]:active]:bg-raised">
        <button
          type="button"
          aria-expanded={open}
          data-hover="parent"
          onClick={() => {
            setOpen((value) => !value);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
        >
          <Chevron
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 text-text-faint"
          />
          <span className="truncate text-sm text-text">{label}</span>
          {delivery.is_test && <Badge>Test</Badge>}
          {delivery.redelivery_of !== null && <Badge>Redelivery</Badge>}
        </button>
        <Badge tone={state.tone}>{state.label}</Badge>
        {last !== undefined && (
          <span className="w-24 text-right font-mono text-2xs text-text-muted">
            {statusCodeLabel(last.status_code)}
            {` ${String(last.latency_ms)} ms`}
          </span>
        )}
        <RelativeTime value={delivery.created_at} className="w-14 text-right" />
        {!isInFlight(delivery) && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Redeliver ${label}`}
            disabled={redelivering}
            onClick={() => {
              onRedeliver(delivery.delivery_id);
            }}
          >
            Redeliver
          </Button>
        )}
      </div>

      {open && (
        <div className="space-y-3 border-t border-line bg-surface px-3 py-3">
          <p className="font-mono text-2xs text-text-faint">
            {delivery.delivery_id}
            {delivery.redelivery_of === null
              ? ''
              : `, redelivery of ${delivery.redelivery_of}`}
          </p>
          {delivery.next_attempt_at !== null && (
            <p className="text-xs text-text-muted">
              Next attempt {fullTimestamp(delivery.next_attempt_at)}
            </p>
          )}
          {delivery.attempts.length === 0 ? (
            <p className="text-xs text-text-muted">No attempt has run yet.</p>
          ) : (
            <ol className="space-y-3">
              {delivery.attempts.map((attempt) => (
                <li key={attempt.attempt} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-text">
                      Attempt {String(attempt.attempt)}
                    </span>
                    <Badge tone={statusCodeTone(attempt.status_code)}>
                      {statusCodeLabel(attempt.status_code)}
                    </Badge>
                    <span className="text-text-muted">
                      {String(attempt.latency_ms)} ms
                    </span>
                    <span className="text-text-faint">
                      {fullTimestamp(attempt.at)}
                    </span>
                  </div>
                  {attempt.error !== null && (
                    <p className="text-xs text-danger">{attempt.error}</p>
                  )}
                  <Body label="Response body" text={attempt.response_body} />
                </li>
              ))}
            </ol>
          )}
          <Body
            label="Request body"
            text={delivery.request_body}
            truncated={delivery.request_truncated}
          />
        </div>
      )}
    </li>
  );
};

/** The delivery log of one webhook, with test ping and redelivery. */
export const WebhookDeliveries: React.FC<WebhookDeliveriesProps> = ({
  scope,
  webhookId,
}) => {
  const auth = useQueryAuth();
  const logKey = webhookDeliveriesKey(webhookId);
  const listKey = webhooksKey(scope.workspaceId, scope.teamId);
  const [lastPing, setLastPing] = useState<WebhookDeliveryRead | null>(null);
  const [redelivering, setRedelivering] = useState<string | null>(null);
  const [active, setActive] = useState(false);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWebhookDeliveries(scope, webhookId, signal),
    {
      intervalMs: active ? ACTIVE_POLL_MS : IDLE_POLL_MS,
      queryKey: logKey,
      auth,
    }
  );

  const inFlight = (data ?? []).some(isInFlight);
  if (inFlight !== active) setActive(inFlight);

  const {
    mutate: ping,
    isMutating: pinging,
    error: pingError,
  } = useMutationWithRefetch(
    () => pingWebhook(scope, webhookId),
    [logKey, listKey]
  );

  const { mutate: redeliver, error: redeliverError } = useMutationWithRefetch(
    (deliveryId: string) =>
      redeliverWebhookDelivery(scope, webhookId, deliveryId),
    [logKey, listKey]
  );

  const onPing = (): void => {
    setLastPing(null);
    void ping()
      .then(setLastPing)
      .catch(() => undefined);
  };

  const onRedeliver = (deliveryId: string): void => {
    setRedelivering(deliveryId);
    const done = (): void => {
      setRedelivering(null);
    };
    void redeliver(deliveryId).then(done, done);
  };

  const pingAttempt = lastPing === null ? undefined : lastAttempt(lastPing);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-medium text-text-muted">
          Recent deliveries
        </h4>
        <Button size="sm" onClick={onPing} disabled={pinging}>
          <LuSend aria-hidden="true" className="h-3.5 w-3.5" />
          {pinging ? 'Sending' : 'Send test ping'}
        </Button>
      </div>

      {lastPing !== null && (
        <p role="status" className="text-xs text-text-muted">
          Test ping {DELIVERY_STATES[lastPing.state].label.toLowerCase()}
          {pingAttempt === undefined
            ? '.'
            : `: ${statusCodeLabel(pingAttempt.status_code)} in ${String(pingAttempt.latency_ms)} ms.`}
        </p>
      )}

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the deliveries.')}
        />
      )}
      {pingError !== null && (
        <ErrorAlert
          message={errorMessage(pingError, 'Could not send the test ping.')}
        />
      )}
      {redeliverError !== null && (
        <ErrorAlert
          message={errorMessage(
            redeliverError,
            'Could not redeliver that delivery.'
          )}
        />
      )}

      {isLoading || data === null ? (
        <Spinner label="Loading deliveries" />
      ) : data.length === 0 ? (
        <p className="text-xs text-text-muted">
          Nothing has been delivered yet. Send a test ping to check the
          receiver.
        </p>
      ) : (
        <ul className="rounded-md border border-line bg-bg">
          {data.map((delivery) => (
            <DeliveryRow
              key={delivery.delivery_id}
              delivery={delivery}
              onRedeliver={onRedeliver}
              redelivering={redelivering === delivery.delivery_id}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

export default WebhookDeliveries;
