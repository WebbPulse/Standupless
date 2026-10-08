/**
 * The step-up prompt through a second-factor lockout: the wait it shows and the
 * Verify button it holds until the wait is over.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StepUpFailure, StepUpGate } from '@webbpulse/auth/react';
import { describe, expect, it, vi } from 'vitest';
import StepUpDialog from './StepUpDialog';

/** A gate with an open prompt whose last submit failed with `error`. */
const gateWith = (error: StepUpFailure | null): StepUpGate => ({
  open: true,
  maxAge: null,
  pending: false,
  error,
  submit: vi.fn(() => Promise.resolve(false)),
  cancel: vi.fn(),
  withStepUp: vi.fn() as unknown as StepUpGate['withStepUp'],
});

/** The refusal the identity service answers a lockout with. */
const lockout = (retryAfter: number | undefined): StepUpFailure => ({
  ok: false,
  reason: 'rate-limited',
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Too many failed attempts.',
  retryAfter,
});

describe('StepUpDialog', () => {
  it('says how long a lockout lasts and holds Verify', async () => {
    const user = userEvent.setup();
    render(
      <StepUpDialog gate={gateWith(lockout(300))} action="unlink" reauth={[]} />
    );

    expect(
      screen.getByText('Too many attempts, try again in 5 minutes.')
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();
  });

  it('lets Verify through again once the wait is over', async () => {
    const user = userEvent.setup();
    render(
      <StepUpDialog gate={gateWith(lockout(1))} action="unlink" reauth={[]} />
    );
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled();

    await waitFor(
      () => {
        expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
      },
      { timeout: 3000 }
    );
    expect(screen.getByText('Too many failed attempts.')).toBeInTheDocument();
  });

  it('shows any other refusal as the server words it', async () => {
    const user = userEvent.setup();
    render(
      <StepUpDialog
        gate={gateWith({
          ok: false,
          reason: 'invalid-code',
          code: 'INVALID_MFA_CODE',
          message: 'That code is not valid.',
        })}
        action="unlink"
        reauth={[]}
      />
    );

    expect(screen.getByText('That code is not valid.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'hunter2');
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled();
  });
});
