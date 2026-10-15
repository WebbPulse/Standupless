import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it } from 'vitest';

import { errorMessage, isPlanFeatureUnavailable, isPlanLimit } from './errors';

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

/** The envelope a gated write answers when the plan lacks the feature. */
const planFeatureBody = (message: string, requiredPlan: string | null) => ({
  success: false,
  status: 403,
  message,
  request_id: 'req-3',
  error_code: 'PLAN_FEATURE_UNAVAILABLE',
  details: { feature: 'issue_slas', plan: 'free', required_plan: requiredPlan },
});

describe('plan feature errors', () => {
  it('recognises the plan feature code and not the limit code', () => {
    const gated = refusal(403, planFeatureBody('No.', 'business'));
    const full = refusal(403, planLimitBody('Full.'));
    expect(isPlanFeatureUnavailable(gated)).toBe(true);
    expect(isPlanFeatureUnavailable(full)).toBe(false);
  });

  it('shows the server sentence, which names the feature and the plan', () => {
    const message =
      'Issue SLAs is not included in the Free plan. Upgrade the workspace to the Business plan to use it.';
    const gated = refusal(403, planFeatureBody(message, 'business'));
    expect(errorMessage(gated, 'Could not save.')).toBe(message);
  });

  it('falls back to naming the plan to move to, not a permission problem', () => {
    const named = refusal(403, planFeatureBody('', 'business'));
    const unnamed = refusal(403, planFeatureBody('', null));
    expect(errorMessage(named, 'Could not save.')).toBe(
      'This feature needs the Business plan. Upgrade the workspace on the billing page to use it.'
    );
    expect(errorMessage(unnamed, 'Could not save.')).toBe(
      'This feature is not included in the workspace plan. Upgrade the workspace on the billing page to use it.'
    );
  });
});
