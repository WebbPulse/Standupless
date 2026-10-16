/**
 * The single sign-on helpers: refusal codes read as sentences, every start
 * returns through the sign-in page, and a refused connection field is read
 * from the envelope whether it sits at the top or under `details`.
 */

import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it } from 'vitest';
import { describeSsoError, ssoInvalidField, ssoLoginReturn } from './sso';

/** A refusal with `body` in the WebbPulse envelope. */
const refusal = (body: Record<string, unknown>): ApiError =>
  new ApiError({
    status: 422,
    statusText: 'Unprocessable Entity',
    body: { success: false, message: 'Refused.', ...body },
    url: '/api/workspaces/ws-1/sso/connection',
    method: 'PUT',
  });

describe('describeSsoError', () => {
  it('reads a cancel and falls back for any other code', () => {
    expect(describeSsoError('SSO_CANCELLED')).toBe('Sign-in was cancelled.');
    expect(describeSsoError('SSO_STATE_INVALID')).toBe(
      'Single sign-on did not complete. Try again or contact your workspace admin.'
    );
    expect(describeSsoError(null)).toBeNull();
    expect(describeSsoError('')).toBeNull();
  });
});

describe('ssoLoginReturn', () => {
  it('returns through the sign-in page', () => {
    expect(ssoLoginReturn('/w/engineering')).toBe(
      '/login?returnTo=%2Fw%2Fengineering&sso_login=1'
    );
  });
});

describe('ssoInvalidField', () => {
  it('reads the field at the top of the envelope', () => {
    expect(
      ssoInvalidField(
        refusal({ error_code: 'SSO_CONNECTION_INVALID', field: 'oidc_issuer' })
      )
    ).toBe('oidc_issuer');
  });

  it('reads the field under details', () => {
    expect(
      ssoInvalidField(
        refusal({
          error_code: 'SSO_CONNECTION_INVALID',
          details: { field: 'saml_idp_certificate' },
        })
      )
    ).toBe('saml_idp_certificate');
  });

  it('ignores other codes and unknown fields', () => {
    expect(
      ssoInvalidField(refusal({ error_code: 'OTHER', field: 'oidc_issuer' }))
    ).toBeNull();
    expect(
      ssoInvalidField(
        refusal({ error_code: 'SSO_CONNECTION_INVALID', field: 'nope' })
      )
    ).toBeNull();
    expect(ssoInvalidField(new Error('no'))).toBeNull();
  });
});
