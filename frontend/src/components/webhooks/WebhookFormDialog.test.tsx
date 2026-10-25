/**
 * The webhook form shows a refusal from the API inside the dialog, in the
 * server's own words, so a workspace or team at its webhook ceiling reads the
 * limit beside the form rather than a generic failure.
 */

import { render, screen } from '@testing-library/react';
import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it, vi } from 'vitest';
import WebhookFormDialog from './WebhookFormDialog';

const LIMIT_MESSAGE =
  'A team can have at most 30 webhooks. Delete one to add another.';

describe('WebhookFormDialog', () => {
  it('shows the webhook ceiling refusal inline', () => {
    const error = new ApiError({
      status: 409,
      statusText: 'Conflict',
      body: { error_code: 'WEBHOOK_LIMIT_REACHED', message: LIMIT_MESSAGE },
      url: '/api/workspaces/ws-1/teams/team-1/webhooks',
      method: 'POST',
    });

    render(
      <WebhookFormDialog
        saving={false}
        error={error}
        onSave={vi.fn(() => Promise.resolve())}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog')).toHaveTextContent(LIMIT_MESSAGE);
  });
});
