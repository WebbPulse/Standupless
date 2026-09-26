/**
 * The outbound webhooks of one scope, the whole workspace or one team, laid
 * out as Linear lays out its own: a list of webhooks with their label, URL,
 * resource types and last response, an enabled switch on each row, and a row
 * that opens to its delivery log.
 *
 * The signing secret is returned by the create and rotate calls and by nothing
 * else, so it is held in state and shown until dismissed. A rotate takes
 * effect at once with no overlap window, so it asks first and says so. A
 * webhook the server switched off after repeated failures carries a warning
 * with its own re-enable action, since the person reading the list did not
 * turn it off and may not know why it went quiet.
 */

import React, { useState } from 'react';
import {
  LuChevronDown,
  LuChevronRight,
  LuEllipsis,
  LuPencil,
  LuPlus,
  LuRotateCw,
  LuTrash2,
  LuTriangleAlert,
} from 'react-icons/lu';
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
  type WebhookScope,
} from '../../api/integrations';
import { errorMessage } from '../../lib/errors';
import { webhooksKey } from '../../lib/queryKeys';
import { fullTimestamp } from '../../lib/relativeTime';
import type {
  TeamRead,
  WebhookEndpointCreate,
  WebhookEndpointRead,
  WebhookEndpointUpdate,
} from '../../types/Api';
import { ErrorAlert } from '../ui/alert';
import Badge from '../ui/badge';
import Button, { IconButton } from '../ui/button';
import Dialog from '../ui/dialog';
import { Menu, MenuItem, MenuSeparator } from '../ui/menu';
import RelativeTime from '../ui/relative-time';
import Spinner from '../ui/spinner';
import WebhookDeliveries from './WebhookDeliveries';
import WebhookFormDialog from './WebhookFormDialog';
import {
  resourceTypesLabel,
  statusCodeLabel,
  statusCodeTone,
} from './webhookDisplay';

/** Props for WebhooksPanel. */
export interface WebhooksPanelProps {
  scope: WebhookScope;
  /**
   * The workspace's teams, when the scope is the workspace: they fill the team
   * picker and name each webhook's team. Undefined for a team scope.
   */
  teams?: readonly TeamRead[];
  /** The heading level the section sits at on its page. */
  headingLevel?: 2 | 3;
  /** The sentence under the heading. */
  description: string;
}

/** How often the list is re-read while the settings page is open. */
const POLL_MS = 30000;

/** Which form, if any, is open: a new webhook or an edit of one. */
type FormState =
  { mode: 'create' } | { mode: 'edit'; webhook: WebhookEndpointRead };

/** Which confirmation, if any, is open. */
type ConfirmState =
  | { kind: 'rotate'; webhook: WebhookEndpointRead }
  | { kind: 'delete'; webhook: WebhookEndpointRead };

/** How to verify a delivery, shown once under the list. */
const SigningHelp: React.FC = () => (
  <div className="space-y-2 rounded-md border border-line bg-surface p-3 text-xs text-text-muted">
    <p className="font-medium text-text">Verifying deliveries</p>
    <p>
      Every request carries{' '}
      <code className="font-mono text-text">
        X-Webhook-Signature: sha256=&lt;hex&gt;
      </code>
      , an HMAC-SHA256 keyed with the signing secret, the whole string as shown,
      over{' '}
      <code className="font-mono text-text">
        &lt;X-Webhook-Timestamp&gt;.&lt;raw body&gt;
      </code>
      . Compute it on the raw bytes before parsing and compare in constant time.
    </p>
    <p>
      <code className="font-mono text-text">X-Webhook-Delivery</code> carries
      the delivery id and{' '}
      <code className="font-mono text-text">X-Webhook-Event</code> the event
      type. The JSON body holds <code className="font-mono">action</code>,{' '}
      <code className="font-mono">type</code>,{' '}
      <code className="font-mono">data</code>,{' '}
      <code className="font-mono">url</code>,{' '}
      <code className="font-mono">createdAt</code> and, on updates,{' '}
      <code className="font-mono">updatedFrom</code>.
    </p>
  </div>
);

/** Lists, creates and edits the webhooks of one scope. */
export const WebhooksPanel: React.FC<WebhooksPanelProps> = ({
  scope,
  teams,
  headingLevel = 2,
  description,
}) => {
  const auth = useQueryAuth();
  const queryKey = webhooksKey(scope.workspaceId, scope.teamId);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [revealed, setRevealed] = useState<WebhookEndpointRead | null>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, error, isLoading } = usePolledQuery(
    ({ signal }) => listWebhooks(scope, signal),
    { intervalMs: POLL_MS, queryKey, auth }
  );

  const {
    mutate: create,
    isMutating: creating,
    error: createError,
  } = useMutationWithRefetch(
    (body: WebhookEndpointCreate) => createWebhook(scope, body),
    queryKey
  );

  const {
    mutate: save,
    isMutating: saving,
    error: saveError,
  } = useMutationWithRefetch(
    (input: { webhookId: string; body: WebhookEndpointUpdate }) =>
      updateWebhook(scope, input.webhookId, input.body),
    queryKey
  );

  const { mutate: toggle, error: toggleError } = useMutationWithRefetch(
    (input: { webhookId: string; enabled: boolean }) =>
      updateWebhook(scope, input.webhookId, { enabled: input.enabled }),
    queryKey
  );

  const {
    mutate: rotate,
    isMutating: rotating,
    error: rotateError,
  } = useMutationWithRefetch(
    (webhookId: string) => rotateWebhookSecret(scope, webhookId),
    queryKey
  );

  const {
    mutate: remove,
    isMutating: removing,
    error: removeError,
  } = useMutationWithRefetch(
    (webhookId: string) => deleteWebhook(scope, webhookId),
    queryKey
  );

  const teamName = (teamId: string | null): string => {
    if (teamId === null) return 'All teams';
    return teams?.find((team) => team.id === teamId)?.name ?? 'Unknown team';
  };

  const reveal = (webhook: WebhookEndpointRead): void => {
    setRevealed(webhook);
    setCopied(false);
  };

  const onSave = async (body: WebhookEndpointCreate): Promise<void> => {
    if (form?.mode === 'edit') {
      await save({ webhookId: form.webhook.webhook_id, body });
      setForm(null);
      return;
    }
    const created = await create(body);
    setForm(null);
    reveal(created);
  };

  const onConfirm = (): void => {
    if (confirm === null) return;
    const { webhook } = confirm;
    if (confirm.kind === 'rotate') {
      void rotate(webhook.webhook_id)
        .then((result) => {
          setConfirm(null);
          reveal(result);
        })
        .catch(() => undefined);
      return;
    }
    void remove(webhook.webhook_id)
      .then(() => {
        setConfirm(null);
        if (expanded === webhook.webhook_id) setExpanded(null);
        if (revealed?.webhook_id === webhook.webhook_id) setRevealed(null);
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

  const setEnabled = (webhook: WebhookEndpointRead, enabled: boolean): void => {
    void toggle({ webhookId: webhook.webhook_id, enabled }).catch(
      () => undefined
    );
  };

  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const confirmBusy = rotating || removing;
  const confirmError = confirm?.kind === 'rotate' ? rotateError : removeError;

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Heading className="text-base font-semibold">Webhooks</Heading>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setForm({ mode: 'create' });
          }}
        >
          <LuPlus aria-hidden="true" className="h-3.5 w-3.5" />
          New webhook
        </Button>
      </div>

      {error !== null && (
        <ErrorAlert
          message={errorMessage(error, 'Could not load the webhooks.')}
        />
      )}
      {toggleError !== null && (
        <ErrorAlert
          message={errorMessage(toggleError, 'Could not change that webhook.')}
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
              This signing secret for {revealed.label} is shown once, so copy it
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

      {isLoading || data === null ? (
        <Spinner label="Loading webhooks" />
      ) : data.length === 0 ? (
        <div className="rounded-md border border-dashed border-line px-4 py-6 text-center">
          <p className="text-sm text-text-muted">No webhooks yet.</p>
          <p className="mt-1 text-xs text-text-faint">
            Create one to send issue, comment, project, cycle and label changes
            to another service.
          </p>
        </div>
      ) : (
        <ul className="rounded-md border border-line">
          {data.map((webhook) => {
            const open = expanded === webhook.webhook_id;
            const Chevron = open ? LuChevronDown : LuChevronRight;
            return (
              <li
                key={webhook.webhook_id}
                className="border-b border-line last:border-b-0"
              >
                <div className="flex min-h-row items-center gap-3 px-3 py-2 transition-colors duration-100 hover:bg-surface">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={`${open ? 'Hide' : 'Show'} deliveries for ${webhook.label}`}
                    onClick={() => {
                      setExpanded(open ? null : webhook.webhook_id);
                    }}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-text-faint hover:bg-raised hover:text-text focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
                  >
                    <Chevron aria-hidden="true" className="h-3.5 w-3.5" />
                  </button>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">
                        {webhook.label}
                      </span>
                      {teams !== undefined && (
                        <Badge
                          tone={webhook.team_id === null ? 'neutral' : 'accent'}
                        >
                          {teamName(webhook.team_id)}
                        </Badge>
                      )}
                      {!webhook.enabled && (
                        <Badge
                          tone={
                            webhook.disabled_reason === null
                              ? 'neutral'
                              : 'danger'
                          }
                        >
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <p className="truncate font-mono text-xs text-text-muted">
                      {webhook.url}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-text-faint">
                      <span>{resourceTypesLabel(webhook.resource_types)}</span>
                      <span aria-hidden="true">·</span>
                      <span>secret ending {webhook.secret_hint}</span>
                      <span aria-hidden="true">·</span>
                      {webhook.last_status === null ? (
                        <span>No deliveries yet</span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          Last delivery
                          <Badge tone={statusCodeTone(webhook.last_status)}>
                            {statusCodeLabel(webhook.last_status)}
                          </Badge>
                          {webhook.last_delivery_at !== null && (
                            <RelativeTime value={webhook.last_delivery_at} />
                          )}
                        </span>
                      )}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Enable ${webhook.label}`}
                    checked={webhook.enabled}
                    onChange={(event) => {
                      setEnabled(webhook, event.target.checked);
                    }}
                    className="h-4 w-7 shrink-0 cursor-pointer accent-accent"
                  />
                  <Menu
                    label={`${webhook.label} actions`}
                    align="end"
                    trigger={(props) => (
                      <IconButton
                        label={`${webhook.label} actions`}
                        size="sm"
                        {...props}
                      >
                        <LuEllipsis className="h-3.5 w-3.5" />
                      </IconButton>
                    )}
                  >
                    <MenuItem
                      onSelect={() => {
                        setForm({ mode: 'edit', webhook });
                      }}
                    >
                      <LuPencil aria-hidden="true" className="h-3.5 w-3.5" />
                      Edit
                    </MenuItem>
                    <MenuItem
                      onSelect={() => {
                        setConfirm({ kind: 'rotate', webhook });
                      }}
                    >
                      <LuRotateCw aria-hidden="true" className="h-3.5 w-3.5" />
                      Rotate secret
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      danger
                      onSelect={() => {
                        setConfirm({ kind: 'delete', webhook });
                      }}
                    >
                      <LuTrash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      Delete
                    </MenuItem>
                  </Menu>
                </div>

                {webhook.disabled_reason !== null && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 border-t border-line bg-warning-soft px-3 py-2 text-xs text-warning"
                  >
                    <LuTriangleAlert
                      aria-hidden="true"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="font-medium">
                        Disabled after repeated failures
                      </p>
                      <p>
                        {webhook.disabled_reason}
                        {webhook.disabled_at === null
                          ? ''
                          : ` Switched off ${fullTimestamp(webhook.disabled_at)}.`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setEnabled(webhook, true);
                      }}
                    >
                      Re-enable
                    </Button>
                  </div>
                )}

                {open && (
                  <div className="border-t border-line bg-surface/50 px-3 py-3">
                    <WebhookDeliveries
                      scope={scope}
                      webhookId={webhook.webhook_id}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <SigningHelp />

      {form !== null && (
        <WebhookFormDialog
          {...(form.mode === 'edit' ? { webhook: form.webhook } : {})}
          {...(teams === undefined ? {} : { teams })}
          saving={form.mode === 'edit' ? saving : creating}
          error={form.mode === 'edit' ? saveError : createError}
          onSave={onSave}
          onClose={() => {
            setForm(null);
          }}
        />
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => {
          if (!confirmBusy) setConfirm(null);
        }}
        title={
          confirm?.kind === 'rotate'
            ? 'Rotate signing secret?'
            : 'Delete webhook?'
        }
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            {confirm?.kind === 'rotate'
              ? `A new secret replaces the current one for ${confirm.webhook.label} at once. Deliveries are signed with the new secret straight away, so update the receiver before the next event.`
              : `${confirm?.webhook.label ?? 'This webhook'} stops receiving events and its delivery log is removed. This cannot be undone.`}
          </p>
          {confirm !== null && confirmError !== null && (
            <ErrorAlert
              message={errorMessage(
                confirmError,
                confirm.kind === 'rotate'
                  ? 'Could not rotate that secret.'
                  : 'Could not delete that webhook.'
              )}
            />
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant={confirm?.kind === 'rotate' ? 'primary' : 'danger'}
              disabled={confirmBusy}
              onClick={onConfirm}
            >
              {confirm?.kind === 'rotate'
                ? rotating
                  ? 'Rotating'
                  : 'Rotate secret'
                : removing
                  ? 'Deleting'
                  : 'Delete webhook'}
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
};

export default WebhooksPanel;
