/**
 * How webhook fields read in the interface: the resource type names, the
 * delivery states and their tints, and response codes, where 0 is a delivery
 * that got no answer at all rather than an HTTP status.
 */

import type { BadgeTone } from '../ui/badge';
import type {
  WebhookDeliveryAction,
  WebhookDeliveryRead,
  WebhookDeliveryState,
  WebhookResourceType,
} from '../../types/Api';

/** How each resource type reads in the form and the list. */
export const RESOURCE_TYPE_LABELS: Record<WebhookResourceType, string> = {
  issues: 'Issues',
  comments: 'Comments',
  projects: 'Projects',
  cycles: 'Cycles',
  labels: 'Labels',
};

/** A webhook's resource types as one line, in the order they were given. */
export const resourceTypesLabel = (types: readonly string[]): string =>
  types
    .map(
      (type) =>
        (RESOURCE_TYPE_LABELS as Record<string, string | undefined>)[type] ??
        type
    )
    .join(', ');

/** How each delivery state reads, and the tint its badge takes. */
export const DELIVERY_STATES: Record<
  WebhookDeliveryState,
  { label: string; tone: BadgeTone }
> = {
  pending: { label: 'Pending', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Whether a delivery may still change on its own, so the log keeps polling. */
export const isInFlight = (delivery: WebhookDeliveryRead): boolean =>
  delivery.state === 'pending' || delivery.state === 'retrying';

/** How each payload type reads, with the label type under its product name. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  Issue: 'Issue',
  Comment: 'Comment',
  Project: 'Project',
  Cycle: 'Cycle',
  IssueLabel: 'Label',
  Webhook: 'Webhook',
};

/** How each action reads after the type it happened to. */
const ACTION_WORDS: Record<WebhookDeliveryAction, string> = {
  create: 'created',
  update: 'updated',
  remove: 'removed',
  ping: 'ping',
};

/** A delivery's event as a short phrase, such as "Issue updated". */
export const deliveryEventLabel = (delivery: WebhookDeliveryRead): string => {
  if (delivery.action === 'ping') return 'Test ping';
  const type = EVENT_TYPE_LABELS[delivery.event_type] ?? delivery.event_type;
  const action =
    (ACTION_WORDS as Record<string, string | undefined>)[delivery.action] ??
    delivery.action;
  return `${type} ${action}`;
};

/** A response code as it reads, with 0 as the absence of any response. */
export const statusCodeLabel = (code: number): string =>
  code === 0 ? 'No response' : String(code);

/** The tint a response code takes: green for 2xx, red for everything else. */
export const statusCodeTone = (code: number): BadgeTone =>
  code >= 200 && code < 300 ? 'success' : 'danger';
