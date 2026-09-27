/**
 * One webhook's delivery log. Each row reads its event, state and last
 * response, opens to every attempt and the payload it carried, and offers a
 * redelivery once it has settled. A test ping and a redelivery both call their
 * route and read the log again, so the new row shows without a reload.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookScope } from '../../api/integrations';
import type { WebhookDeliveryRead } from '../../types/Api';
import WebhookDeliveries from './WebhookDeliveries';

const listWebhookDeliveries =
  vi.fn<(id: string) => Promise<WebhookDeliveryRead[]>>();
const pingWebhook = vi.fn<(id: string) => Promise<WebhookDeliveryRead>>();
const redeliverWebhookDelivery =
  vi.fn<(id: string, deliveryId: string) => Promise<WebhookDeliveryRead>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listWebhookDeliveries: (_s: WebhookScope, id: string) =>
      listWebhookDeliveries(id),
    pingWebhook: (_s: WebhookScope, id: string) => pingWebhook(id),
    redeliverWebhookDelivery: (_s: WebhookScope, id: string, d: string) =>
      redeliverWebhookDelivery(id, d),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

/** The workspace scope the log is read through. */
const scope: WebhookScope = { workspaceId: 'ws-1', teamId: null };

/** One delivery in the shape the contract answers with. */
const delivery = (
  over: Partial<WebhookDeliveryRead> = {}
): WebhookDeliveryRead => ({
  delivery_id: 'del-1',
  webhook_id: 'wh-1',
  event_type: 'Issue',
  action: 'update',
  state: 'delivered',
  is_test: false,
  redelivery_of: null,
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  next_attempt_at: null,
  attempts: [
    {
      attempt: 1,
      at: '2026-09-18T00:00:00Z',
      status_code: 200,
      latency_ms: 12,
      error: null,
      response_body: 'ok',
    },
  ],
  request_body: '{"action":"update","type":"Issue"}',
  request_truncated: false,
  ...over,
});

/** A delivery that failed every attempt and whose payload was cut short. */
const failed = delivery({
  delivery_id: 'del-2',
  event_type: 'IssueLabel',
  action: 'create',
  state: 'failed',
  attempts: [
    {
      attempt: 1,
      at: '2026-09-18T00:00:00Z',
      status_code: 0,
      latency_ms: 5000,
      error: 'Timed out after 5 seconds.',
      response_body: '',
    },
    {
      attempt: 2,
      at: '2026-09-18T00:01:00Z',
      status_code: 503,
      latency_ms: 40,
      error: null,
      response_body: 'Service Unavailable',
    },
  ],
  request_truncated: true,
});

beforeEach(() => {
  listWebhookDeliveries.mockReset();
  pingWebhook.mockReset();
  redeliverWebhookDelivery.mockReset();
  listWebhookDeliveries.mockResolvedValue([delivery(), failed]);
  pingWebhook.mockResolvedValue(
    delivery({ delivery_id: 'del-3', action: 'ping', is_test: true })
  );
  redeliverWebhookDelivery.mockResolvedValue(
    delivery({ delivery_id: 'del-4', redelivery_of: 'del-2' })
  );
});

describe('the delivery log', () => {
  it('lists each delivery with its event, state and last response', async () => {
    render(<WebhookDeliveries scope={scope} webhookId="wh-1" />);

    expect(await screen.findByText('Issue updated')).toBeInTheDocument();
    expect(listWebhookDeliveries).toHaveBeenCalledWith('wh-1');
    expect(screen.getByText('Label created')).toBeInTheDocument();
    expect(screen.getByText('Delivered')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('200 12 ms')).toBeInTheDocument();
    expect(screen.getByText('503 40 ms')).toBeInTheDocument();
  });

  it('opens a delivery to its attempts and payload', async () => {
    render(<WebhookDeliveries scope={scope} webhookId="wh-1" />);

    const toggle = (await screen.findByText('Label created')).closest('button');
    expect(toggle).not.toBeNull();
    if (toggle === null) return;
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Attempt 1')).toBeInTheDocument();
    expect(screen.getByText('Attempt 2')).toBeInTheDocument();
    expect(screen.getByText('No response')).toBeInTheDocument();
    expect(screen.getByText('Timed out after 5 seconds.')).toBeInTheDocument();
    expect(screen.getByText('Service Unavailable')).toBeInTheDocument();
    expect(screen.getByText('Request body (truncated)')).toBeInTheDocument();
  });

  it('holds back a redelivery while a delivery is still in flight', async () => {
    listWebhookDeliveries.mockResolvedValue([
      delivery({ state: 'retrying', next_attempt_at: '2026-09-18T00:05:00Z' }),
    ]);
    render(<WebhookDeliveries scope={scope} webhookId="wh-1" />);

    expect(await screen.findByText('Retrying')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Redeliver/ })
    ).not.toBeInTheDocument();
  });

  it('sends a test ping, reports it and reads the log again', async () => {
    render(<WebhookDeliveries scope={scope} webhookId="wh-1" />);
    await screen.findByText('Issue updated');
    const reads = listWebhookDeliveries.mock.calls.length;

    await userEvent.click(
      screen.getByRole('button', { name: 'Send test ping' })
    );

    expect(pingWebhook).toHaveBeenCalledWith('wh-1');
    const status = await screen.findByRole('status');
    expect(
      within(status).getByText('Test ping delivered: 200 in 12 ms.')
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(listWebhookDeliveries.mock.calls.length).toBeGreaterThan(reads);
    });
  });

  it('redelivers one delivery by its id and reads the log again', async () => {
    render(<WebhookDeliveries scope={scope} webhookId="wh-1" />);
    await screen.findByText('Label created');
    const reads = listWebhookDeliveries.mock.calls.length;

    await userEvent.click(
      screen.getByRole('button', { name: 'Redeliver Label created' })
    );

    await waitFor(() => {
      expect(redeliverWebhookDelivery).toHaveBeenCalledWith('wh-1', 'del-2');
    });
    await waitFor(() => {
      expect(listWebhookDeliveries.mock.calls.length).toBeGreaterThan(reads);
    });
  });
});
