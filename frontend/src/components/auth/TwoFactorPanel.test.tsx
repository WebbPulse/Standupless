/**
 * The authenticator app panel: setting it up shows the QR code and key, a
 * correct code turns it on and shows the recovery codes once, and both turning
 * it on and removing it refresh the session so the `two_factor` claim follows.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRead } from '../../types/Api';
import TwoFactorPanel from './TwoFactorPanel';

const enrolTotp = vi.fn<() => Promise<unknown>>();
const activateTotp = vi.fn<(input: { code: string }) => Promise<unknown>>();
const disableTotp = vi.fn<(input: { code: string }) => Promise<unknown>>();
const refresh = vi.fn<() => Promise<string | null>>();
const reloadUser = vi.fn<() => Promise<unknown>>();
let currentUser: UserRead | null = null;

const fakeClient = {
  enrolTotp: () => enrolTotp(),
  activateTotp: (input: { code: string }) => activateTotp(input),
  disableTotp: (input: { code: string }) => disableTotp(input),
  regenerateRecoveryCodes: () =>
    Promise.resolve({ ok: true, recoveryCodes: [] }),
  refresh: () => refresh(),
  reloadUser: () => reloadUser(),
};

vi.mock('../../api/identityClient', () => ({
  getIdentityClient: () => fakeClient,
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: currentUser,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

/** The signed in person, with or without a factor. */
const user = (twoFactor: boolean): UserRead => ({
  id: 'user-1',
  email: 'me@example.com',
  display_name: 'Me',
  email_verified: true,
  two_factor: twoFactor,
});

beforeEach(() => {
  enrolTotp.mockReset();
  activateTotp.mockReset();
  disableTotp.mockReset();
  refresh.mockReset();
  reloadUser.mockReset();
  refresh.mockResolvedValue('token');
  reloadUser.mockResolvedValue(null);
  currentUser = user(false);
});

describe('the authenticator app panel', () => {
  it('sets up an authenticator app and shows the recovery codes once', async () => {
    enrolTotp.mockResolvedValue({
      ok: true,
      secret: 'JBSWY3DPEHPK3PXP',
      provisioningUri:
        'otpauth://totp/Standupless:me@example.com?secret=JBSWY3DPEHPK3PXP',
    });
    activateTotp.mockResolvedValue({
      ok: true,
      recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'],
    });
    render(<TwoFactorPanel />);

    expect(screen.getByText('Off')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));

    expect(
      await screen.findByRole('img', {
        name: 'QR code for your authenticator app',
      })
    ).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument();

    await userEvent.type(
      screen.getByLabelText('Code from your authenticator app'),
      '123456{Enter}'
    );

    await waitFor(() => {
      expect(activateTotp).toHaveBeenCalledWith({ code: '123456' });
    });
    expect(await screen.findByText('aaaa-bbbb')).toBeInTheDocument();
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByRole('button', { name: 'I saved them' }));
    expect(screen.queryByText('aaaa-bbbb')).not.toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
  });

  it('removes the app with a code and refreshes the session', async () => {
    currentUser = user(true);
    disableTotp.mockResolvedValue({ ok: true });
    render(<TwoFactorPanel />);

    expect(screen.getByText('On')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await userEvent.type(
      screen.getByLabelText('Code to remove the authenticator app'),
      '654321'
    );
    const submits = screen.getAllByRole('button', { name: 'Remove' });
    await userEvent.click(submits[submits.length - 1] as HTMLElement);

    await waitFor(() => {
      expect(disableTotp).toHaveBeenCalledWith({ code: '654321' });
    });
    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(
      await screen.findByText('Authenticator app removed.')
    ).toBeInTheDocument();
  });

  it('shows the server sentence for a wrong code', async () => {
    enrolTotp.mockResolvedValue({
      ok: true,
      secret: 'JBSWY3DPEHPK3PXP',
      provisioningUri: 'otpauth://totp/Standupless:me?secret=JBSWY3DPEHPK3PXP',
    });
    activateTotp.mockResolvedValue({
      ok: false,
      reason: 'invalid-code',
      code: 'INVALID_CODE',
      message: 'That code is not right.',
    });
    render(<TwoFactorPanel />);

    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await userEvent.type(
      await screen.findByLabelText('Code from your authenticator app'),
      '000000{Enter}'
    );

    expect(
      await screen.findByText('That code is not right.')
    ).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });
});
