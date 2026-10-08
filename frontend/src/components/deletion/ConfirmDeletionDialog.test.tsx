/**
 * The deletion dialog's code step through a second-factor lockout: the wait it
 * shows and the button it holds, with the deletion never sent.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ConfirmDeletionDialog from './ConfirmDeletionDialog';

const stepUpWithPasskey = vi.fn<() => Promise<unknown>>();
const stepUp = vi.fn<(input: { code: string }) => Promise<unknown>>();

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => ({
    stepUpWithPasskey: () => stepUpWithPasskey(),
    stepUp: (input: { code: string }) => stepUp(input),
  }),
}));

beforeEach(() => {
  stepUpWithPasskey.mockReset();
  stepUp.mockReset();
  stepUpWithPasskey.mockResolvedValue({
    ok: false,
    reason: 'no-passkeys',
    message: 'No passkeys.',
  });
});

/** Opens the dialog and gets it to the code step. */
const reachCodeStep = async (onConfirm: () => Promise<void>) => {
  const user = userEvent.setup();
  render(
    <ConfirmDeletionDialog
      open
      onClose={vi.fn()}
      title="Delete workspace"
      confirmLabel="Type Acme to confirm"
      expected="Acme"
      submitLabel="Delete workspace"
      onConfirm={onConfirm}
      failureMessage="Could not delete it."
    >
      <p>Everything goes.</p>
    </ConfirmDeletionDialog>
  );
  await user.type(screen.getByLabelText('Type Acme to confirm'), 'Acme');
  await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
  await screen.findByLabelText('Authenticator or recovery code');
  return user;
};

describe('ConfirmDeletionDialog', () => {
  it('says how long a lockout lasts and holds the code step', async () => {
    stepUp.mockResolvedValue({
      ok: false,
      reason: 'rate-limited',
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many failed attempts.',
      retryAfter: 600,
    });
    const onConfirm = vi.fn(() => Promise.resolve());
    const user = await reachCodeStep(onConfirm);

    await user.type(
      screen.getByLabelText('Authenticator or recovery code'),
      '123456'
    );
    await user.click(
      screen.getByRole('button', { name: 'Verify and schedule' })
    );

    expect(
      await screen.findByText('Too many attempts, try again in 10 minutes.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Verify and schedule' })
    ).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows a wrong code as the server words it and lets another try', async () => {
    stepUp.mockResolvedValue({
      ok: false,
      reason: 'invalid-code',
      code: 'INVALID_MFA_CODE',
      message: 'That code is not valid.',
    });
    const user = await reachCodeStep(vi.fn(() => Promise.resolve()));

    await user.type(
      screen.getByLabelText('Authenticator or recovery code'),
      '123456'
    );
    await user.click(
      screen.getByRole('button', { name: 'Verify and schedule' })
    );

    expect(
      await screen.findByText('That code is not valid.')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Verify and schedule' })
    ).toBeEnabled();
  });
});
