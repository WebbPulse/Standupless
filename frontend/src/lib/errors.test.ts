import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it } from 'vitest';

import { errorMessage, isPlanLimit } from './errors';

/** A refusal carrying the given envelope body, as the shared client throws it. */
const refusal = (status: number, body: unknown): ApiError =>
  new ApiError({
    status,
    statusText: 'Refused',
    body,
    url: '/api/workspaces/ws-1/webhooks',
    method: 'POST',
  });

/** The envelope a create route answers when the plan limit is reached. */
const planLimitBody = (message: string) => ({
  success: false,
  status: 403,
  message,
  request_id: 'req-1',
  error_code: 'PLAN_LIMIT_REACHED',
  details: { resource: 'webhooks', limit: 20, plan: 'free' },
});

describe('plan limit errors', () => {
  it('recognises the plan limit code and nothing else', () => {
    expect(isPlanLimit(refusal(403, planLimitBody('Full.')))).toBe(true);
    expect(
      isPlanLimit(
        refusal(403, {
          success: false,
          status: 403,
          message: 'Not allowed',
          request_id: 'req-2',
          error_code: 'FORBIDDEN',
        })
      )
    ).toBe(false);
    expect(isPlanLimit(new Error('boom'))).toBe(false);
  });

  it('shows the server sentence, which names the number', () => {
    const message =
      'This workspace has reached its free plan limit of 20 webhooks. Remove one to make room.';
    expect(
      errorMessage(refusal(403, planLimitBody(message)), 'Could not create.')
    ).toBe(message);
  });

  it('falls back to a plain limit sentence rather than the generic one', () => {
    expect(
      errorMessage(refusal(403, planLimitBody('')), 'Could not create.')
    ).toBe(
      'This workspace has reached its plan limit. Remove one to make room.'
    );
  });
});
