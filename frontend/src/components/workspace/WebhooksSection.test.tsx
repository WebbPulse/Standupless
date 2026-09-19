/**
 * The webhook settings section. The behaviour worth pinning is the secret:
 * it comes back from the create and the rotate and from nothing else, so both
 * must surface it once and the list must never show it. Also covers that every
 * event is subscribed by default and that pausing sends the flag rather than
 * deleting the endpoint.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEndpointRead, WorkspaceRead } from '../../types/Api';
import WebhooksSection from './WebhooksSection';

const listWebhooks = vi.fn<() => Promise<WebhookEndpointRead[]>>();
const createWebhook = vi.fn<(body: unknown) => Promise<WebhookEndpointRead>>();
const updateWebhook =
  vi.fn<(id: string, body: unknown) => Promise<WebhookEndpointRead>>();
const rotateWebhookSecret =
  vi.fn<(id: string) => Promise<WebhookEndpointRead>>();
const deleteWebhook = vi.fn<(id: string) => Promise<void>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listWebhooks: () => listWebhooks(),
    createWebhook: (_w: string, body: unknown) => createWebhook(body),
    updateWebhook: (_w: string, id: string, body: unknown) =>
      updateWebhook(id, body),
    rotateWebhookSecret: (_w: string, id: string) => rotateWebhookSecret(id),
    deleteWebhook: (_w: string, id: string) => deleteWebhook(id),
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

/** The workspace the section is rendered for. */
const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Engineering',
  slug: 'engineering',
  plan: 'free',
  created_at: '2026-09-18T00:00:00Z',
  role: 'admin',
};

/** One endpoint in the shape the contract answers with. */
const endpoint = (
  over: Partial<WebhookEndpointRead> = {}
): WebhookEndpointRead => ({
  webhook_id: 'wh-1',
  url: 'https://example.test/hook',
  events: ['issue.created'],
  description: null,
  active: true,
  secret_hint: 'ab12',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  last_status: null,
  last_delivery_at: null,
  ...over,
});

beforeEach(() => {
  listWebhooks.mockReset();
  createWebhook.mockReset();
  updateWebhook.mockReset();
  rotateWebhookSecret.mockReset();
  deleteWebhook.mockReset();
  listWebhooks.mockResolvedValue([endpoint()]);
  createWebhook.mockResolvedValue(
    endpoint({ webhook_id: 'wh-2', secret: 'whsec_created' })
  );
  updateWebhook.mockResolvedValue(endpoint({ active: false }));
  rotateWebhookSecret.mockResolvedValue(endpoint({ secret: 'whsec_rotated' }));
  deleteWebhook.mockResolvedValue(undefined);
});

describe('the webhooks section', () => {
  it('lists an endpoint by its hint and never its secret', async () => {
    render(<WebhooksSection workspace={workspace} />);

    expect(
      await screen.findByText('https://example.test/hook')
    ).toBeInTheDocument();
    expect(screen.getByText(/secret ending ab12/)).toBeInTheDocument();
    expect(screen.queryByText(/whsec_/)).not.toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    listWebhooks.mockResolvedValue([]);
    render(<WebhooksSection workspace={workspace} />);

    expect(
      await screen.findByText('There are no webhook endpoints yet.')
    ).toBeInTheDocument();
  });

  it('subscribes every event by default', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.type(
      await screen.findByLabelText('Endpoint URL'),
      'https://receiver.test/hook'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));

    await waitFor(() => {
      expect(createWebhook).toHaveBeenCalledWith({
        url: 'https://receiver.test/hook',
        events: [
          'issue.created',
          'issue.updated',
          'issue.status_changed',
          'comment.created',
        ],
      });
    });
  });

  it('shows the secret a create mints, once', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.type(
      await screen.findByLabelText('Endpoint URL'),
      'https://receiver.test/hook'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));

    expect(await screen.findByText('whsec_created')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('whsec_created')).not.toBeInTheDocument();
  });

  it('shows the secret a rotate mints', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Rotate secret' })
    );

    expect(await screen.findByText('whsec_rotated')).toBeInTheDocument();
  });

  it('pauses an endpoint rather than deleting it', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));

    await waitFor(() => {
      expect(updateWebhook).toHaveBeenCalledWith('wh-1', { active: false });
    });
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it('refuses to submit with no event selected', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.type(
      await screen.findByLabelText('Endpoint URL'),
      'https://receiver.test/hook'
    );
    for (const label of [
      'issue created',
      'issue updated',
      'issue status_changed',
      'comment created',
    ]) {
      await userEvent.click(screen.getByLabelText(label));
    }

    expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeDisabled();
  });
});
