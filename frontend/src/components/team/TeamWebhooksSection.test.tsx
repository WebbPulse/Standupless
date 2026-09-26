/**
 * The team webhooks section. A team admin manages the team's own webhooks
 * through the team route, with no team picker since the route fixes the team,
 * and anyone else sees a note in place of the list without a request being
 * made, since the routes would refuse them.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookScope } from '../../api/integrations';
import type { WebhookEndpointRead } from '../../types/Api';
import TeamWebhooksSection from './TeamWebhooksSection';

const listWebhooks =
  vi.fn<(scope: WebhookScope) => Promise<WebhookEndpointRead[]>>();
const createWebhook =
  vi.fn<(scope: WebhookScope, body: unknown) => Promise<WebhookEndpointRead>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listWebhooks: (scope: WebhookScope) => listWebhooks(scope),
    createWebhook: (scope: WebhookScope, body: unknown) =>
      createWebhook(scope, body),
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

/** The team route's scope. */
const scope: WebhookScope = { workspaceId: 'ws-1', teamId: 'team-1' };

/** One team webhook in the shape the contract answers with. */
const webhook: WebhookEndpointRead = {
  webhook_id: 'wh-1',
  url: 'https://example.test/hook',
  label: 'Team notifier',
  team_id: 'team-1',
  resource_types: ['issues'],
  enabled: true,
  secret_hint: 'cd34',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  last_status: null,
  last_delivery_at: null,
  consecutive_failures: 0,
  disabled_reason: null,
  disabled_at: null,
};

beforeEach(() => {
  listWebhooks.mockReset();
  createWebhook.mockReset();
  listWebhooks.mockResolvedValue([webhook]);
  createWebhook.mockResolvedValue({ ...webhook, secret: 'whsec_team' });
});

describe('the team webhooks section', () => {
  it('lists the team webhooks through the team route with no team badge', async () => {
    render(<TeamWebhooksSection workspaceId="ws-1" teamId="team-1" canEdit />);

    expect(await screen.findByText('Team notifier')).toBeInTheDocument();
    expect(listWebhooks).toHaveBeenCalledWith(scope);
    expect(screen.queryByText('All teams')).not.toBeInTheDocument();
    expect(screen.getByText(/No deliveries yet/)).toBeInTheDocument();
  });

  it('creates a webhook without choosing a team', async () => {
    render(<TeamWebhooksSection workspaceId="ws-1" teamId="team-1" canEdit />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'New webhook' })
    );
    expect(screen.queryByLabelText('Team')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Label'), 'Receiver');
    await userEvent.type(
      screen.getByLabelText('URL'),
      'https://receiver.test/hook'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create webhook' })
    );

    await waitFor(() => {
      expect(createWebhook).toHaveBeenCalledWith(scope, {
        url: 'https://receiver.test/hook',
        label: 'Receiver',
        resource_types: ['issues', 'comments', 'projects', 'cycles', 'labels'],
        enabled: true,
      });
    });
    expect(await screen.findByText('whsec_team')).toBeInTheDocument();
  });

  it('shows a note and makes no request for someone who is not a team admin', () => {
    render(
      <TeamWebhooksSection workspaceId="ws-1" teamId="team-1" canEdit={false} />
    );

    expect(
      screen.getByText("Only a team admin can manage this team's webhooks.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'New webhook' })
    ).not.toBeInTheDocument();
    expect(listWebhooks).not.toHaveBeenCalled();
  });
});
