/**
 * The workspace webhooks section. The behaviour worth pinning is the secret:
 * it comes back from the create and the rotate and from nothing else, so both
 * must surface it once and the list must never show it. Also covers the team
 * picker and badge that only the workspace scope has, a refused URL shown in
 * the server's own words, the confirmations in front of a rotate and a delete,
 * and the warning and re-enable on a webhook switched off after failures.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@webbpulse/api-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookScope } from '../../api/integrations';
import type {
  TeamRead,
  WebhookDeliveryRead,
  WebhookEndpointRead,
  WorkspaceRead,
} from '../../types/Api';
import WebhooksSection from './WebhooksSection';

const listWebhooks =
  vi.fn<(scope: WebhookScope) => Promise<WebhookEndpointRead[]>>();
const createWebhook = vi.fn<(body: unknown) => Promise<WebhookEndpointRead>>();
const updateWebhook =
  vi.fn<(id: string, body: unknown) => Promise<WebhookEndpointRead>>();
const rotateWebhookSecret =
  vi.fn<(id: string) => Promise<WebhookEndpointRead>>();
const deleteWebhook = vi.fn<(id: string) => Promise<void>>();
const listWebhookDeliveries =
  vi.fn<(id: string) => Promise<WebhookDeliveryRead[]>>();

vi.mock('../../api/integrations', async () => {
  const actual = await vi.importActual<typeof import('../../api/integrations')>(
    '../../api/integrations'
  );
  return {
    ...actual,
    listWebhooks: (scope: WebhookScope) => listWebhooks(scope),
    createWebhook: (_s: WebhookScope, body: unknown) => createWebhook(body),
    updateWebhook: (_s: WebhookScope, id: string, body: unknown) =>
      updateWebhook(id, body),
    rotateWebhookSecret: (_s: WebhookScope, id: string) =>
      rotateWebhookSecret(id),
    deleteWebhook: (_s: WebhookScope, id: string) => deleteWebhook(id),
    listWebhookDeliveries: (_s: WebhookScope, id: string) =>
      listWebhookDeliveries(id),
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

/** The one team the workspace holds. */
const team: TeamRead = {
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
};

vi.mock('../../hooks/useTeams', () => ({
  useTeamsFor: () => ({
    data: [team],
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(),
    workspaceId: 'ws-1',
  }),
}));

/** The workspace the section is rendered for. */
const workspace: WorkspaceRead = {
  id: 'ws-1',
  name: 'Engineering',
  slug: 'engineering',
  plan: 'free',
  created_at: '2026-09-18T00:00:00Z',
  role: 'admin',
};

/** One webhook in the shape the contract answers with. */
const webhook = (
  over: Partial<WebhookEndpointRead> = {}
): WebhookEndpointRead => ({
  webhook_id: 'wh-1',
  url: 'https://example.test/hook',
  label: 'Deploy notifier',
  team_id: null,
  resource_types: ['issues', 'comments'],
  enabled: true,
  secret_hint: 'ab12',
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  updated_at: '2026-09-18T00:00:00Z',
  last_status: 200,
  last_delivery_at: '2026-09-18T00:00:00Z',
  consecutive_failures: 0,
  disabled_reason: null,
  disabled_at: null,
  ...over,
});

beforeEach(() => {
  listWebhooks.mockReset();
  createWebhook.mockReset();
  updateWebhook.mockReset();
  rotateWebhookSecret.mockReset();
  deleteWebhook.mockReset();
  listWebhookDeliveries.mockReset();
  listWebhooks.mockResolvedValue([webhook()]);
  createWebhook.mockResolvedValue(
    webhook({ webhook_id: 'wh-2', secret: 'whsec_created' })
  );
  updateWebhook.mockResolvedValue(webhook({ enabled: false }));
  rotateWebhookSecret.mockResolvedValue(webhook({ secret: 'whsec_rotated' }));
  deleteWebhook.mockResolvedValue(undefined);
  listWebhookDeliveries.mockResolvedValue([]);
});

/** Opens a row's action menu and picks one item. */
const pickAction = async (label: string, item: string): Promise<void> => {
  await userEvent.click(
    await screen.findByRole('button', { name: `${label} actions` })
  );
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('the workspace webhooks section', () => {
  it('reads the workspace scope and lists a webhook by its hint, never its secret', async () => {
    listWebhooks.mockResolvedValue([
      webhook(),
      webhook({ webhook_id: 'wh-2', label: 'Team hook', team_id: 'team-1' }),
    ]);
    render(<WebhooksSection workspace={workspace} />);

    expect(await screen.findByText('Deploy notifier')).toBeInTheDocument();
    expect(listWebhooks).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      teamId: null,
    });
    expect(screen.getAllByText('https://example.test/hook')).toHaveLength(2);
    expect(screen.getByText('All teams')).toBeInTheDocument();
    expect(screen.getByText('Engine')).toBeInTheDocument();
    expect(screen.getAllByText('Issues, Comments')).toHaveLength(2);
    expect(screen.getAllByText(/secret ending ab12/)).toHaveLength(2);
    expect(screen.queryByText(/whsec_/)).not.toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    listWebhooks.mockResolvedValue([]);
    render(<WebhooksSection workspace={workspace} />);

    expect(await screen.findByText('No webhooks yet.')).toBeInTheDocument();
  });

  it('creates a webhook for one team and shows its secret once', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'New webhook' })
    );
    const dialog = screen.getByRole('dialog', { name: 'New webhook' });
    await userEvent.type(within(dialog).getByLabelText('Label'), 'Receiver');
    await userEvent.type(
      within(dialog).getByLabelText('URL'),
      'https://receiver.test/hook'
    );
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Team'),
      'team-1'
    );
    await userEvent.click(within(dialog).getByLabelText('Cycles'));
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Create webhook' })
    );

    await waitFor(() => {
      expect(createWebhook).toHaveBeenCalledWith({
        url: 'https://receiver.test/hook',
        label: 'Receiver',
        resource_types: [
          'issues',
          'comments',
          'projects',
          'project_updates',
          'labels',
        ],
        enabled: true,
        team_id: 'team-1',
      });
    });
    expect(await screen.findByText('whsec_created')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('whsec_created')).not.toBeInTheDocument();
  });

  it('sends null for all teams', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'New webhook' })
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Receiver');
    await userEvent.type(
      screen.getByLabelText('URL'),
      'https://receiver.test/hook'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create webhook' })
    );

    await waitFor(() => {
      expect(createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({ team_id: null })
      );
    });
  });

  it('shows a refused URL in the server words and keeps the form open', async () => {
    createWebhook.mockRejectedValue(
      new ApiError({
        status: 422,
        statusText: 'Unprocessable Entity',
        body: {
          error_code: 'UNSAFE_URL',
          message: 'That URL points at a private address.',
        },
        url: '/api/workspaces/ws-1/webhooks',
        method: 'POST',
      })
    );
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'New webhook' })
    );
    await userEvent.type(screen.getByLabelText('Label'), 'Local');
    await userEvent.type(
      screen.getByLabelText('URL'),
      'https://127.0.0.1/hook'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create webhook' })
    );

    const dialog = await screen.findByRole('dialog', { name: 'New webhook' });
    expect(
      await within(dialog).findByText('That URL points at a private address.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/whsec_/)).not.toBeInTheDocument();
  });

  it('refuses to submit with no resource type or no label', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', { name: 'New webhook' })
    );
    await userEvent.type(
      screen.getByLabelText('URL'),
      'https://receiver.test/hook'
    );
    const submit = screen.getByRole('button', { name: 'Create webhook' });
    expect(submit).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Label'), 'Receiver');
    expect(submit).toBeEnabled();

    for (const label of [
      'Issues',
      'Comments',
      'Projects',
      'Project updates',
      'Cycles',
      'Labels',
    ]) {
      await userEvent.click(screen.getByLabelText(label));
    }
    expect(submit).toBeDisabled();
    expect(
      screen.getByText('Choose at least one resource type.')
    ).toBeInTheDocument();
  });

  it('edits a webhook from its current values', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await pickAction('Deploy notifier', 'Edit');
    const dialog = screen.getByRole('dialog', { name: 'Edit webhook' });
    const label = within(dialog).getByLabelText('Label');
    expect(label).toHaveValue('Deploy notifier');
    await userEvent.clear(label);
    await userEvent.type(label, 'Renamed');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Save webhook' })
    );

    await waitFor(() => {
      expect(updateWebhook).toHaveBeenCalledWith('wh-1', {
        url: 'https://example.test/hook',
        label: 'Renamed',
        resource_types: ['issues', 'comments'],
        enabled: true,
        team_id: null,
      });
    });
  });

  it('switches a webhook off with its toggle', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('switch', { name: 'Enable Deploy notifier' })
    );

    await waitFor(() => {
      expect(updateWebhook).toHaveBeenCalledWith('wh-1', { enabled: false });
    });
    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it('warns about a webhook switched off after failures and re-enables it', async () => {
    listWebhooks.mockResolvedValue([
      webhook({
        enabled: false,
        last_status: 500,
        consecutive_failures: 20,
        disabled_reason: 'The last 20 deliveries failed.',
        disabled_at: '2026-09-18T00:00:00Z',
      }),
    ]);
    render(<WebhooksSection workspace={workspace} />);

    const warning = await screen.findByRole('alert');
    expect(
      within(warning).getByText('Disabled after repeated failures')
    ).toBeInTheDocument();
    expect(
      within(warning).getByText(/The last 20 deliveries failed\./)
    ).toBeInTheDocument();

    await userEvent.click(
      within(warning).getByRole('button', { name: 'Re-enable' })
    );

    await waitFor(() => {
      expect(updateWebhook).toHaveBeenCalledWith('wh-1', { enabled: true });
    });
  });

  it('rotates a secret only after confirming, then shows the new one', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await pickAction('Deploy notifier', 'Rotate secret');
    const dialog = screen.getByRole('dialog', {
      name: 'Rotate signing secret?',
    });
    expect(rotateWebhookSecret).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Rotate secret' })
    );

    expect(await screen.findByText('whsec_rotated')).toBeInTheDocument();
    expect(rotateWebhookSecret).toHaveBeenCalledWith('wh-1');
  });

  it('deletes a webhook only after confirming', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await pickAction('Deploy notifier', 'Delete');
    const dialog = screen.getByRole('dialog', { name: 'Delete webhook?' });
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Cancel' })
    );
    expect(deleteWebhook).not.toHaveBeenCalled();

    await pickAction('Deploy notifier', 'Delete');
    await userEvent.click(
      screen.getByRole('button', { name: 'Delete webhook' })
    );

    await waitFor(() => {
      expect(deleteWebhook).toHaveBeenCalledWith('wh-1');
    });
  });

  it('opens a row to its delivery log', async () => {
    render(<WebhooksSection workspace={workspace} />);

    await userEvent.click(
      await screen.findByRole('button', {
        name: 'Show deliveries for Deploy notifier',
      })
    );

    expect(
      await screen.findByText(/Nothing has been delivered yet/)
    ).toBeInTheDocument();
    expect(listWebhookDeliveries).toHaveBeenCalledWith('wh-1');
  });

  it('explains how to verify a signature', async () => {
    render(<WebhooksSection workspace={workspace} />);

    expect(await screen.findByText('Verifying deliveries')).toBeInTheDocument();
    expect(
      screen.getByText('X-Webhook-Signature: sha256=<hex>')
    ).toBeInTheDocument();
  });
});
