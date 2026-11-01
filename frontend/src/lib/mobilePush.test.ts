/**
 * Registering for push: what happens on a refusal and an older app, and that
 * sign-out lets go of the phone without ever being held up by the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPushDevice, unregisterPushDevice } from '../api/views';
import { canUseMobilePush } from './mobile';
import { STOP_WAIT_MS, startMobilePush, stopMobilePush } from './mobilePush';

const plugin = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  addListener: vi.fn(),
  register: vi.fn(),
  removeAllDeliveredNotifications: vi.fn(),
}));

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: plugin,
}));
vi.mock('../api/views', () => ({
  registerPushDevice: vi.fn(),
  unregisterPushDevice: vi.fn(),
}));
vi.mock('./mobile', () => ({ canUseMobilePush: vi.fn() }));

const TOKEN = 'ab'.repeat(32);

/** Runs the registration listener as the plugin would once the system answers. */
const deliverToken = (): void => {
  const call = plugin.addListener.mock.calls[0] as [
    string,
    (event: { value: string }) => void,
  ];
  call[1]({ value: TOKEN });
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(canUseMobilePush).mockReturnValue(true);
  vi.mocked(registerPushDevice).mockResolvedValue(undefined);
  vi.mocked(unregisterPushDevice).mockResolvedValue(undefined);
  plugin.checkPermissions.mockResolvedValue({ receive: 'granted' });
  plugin.requestPermissions.mockResolvedValue({ receive: 'granted' });
  plugin.addListener.mockResolvedValue({ remove: vi.fn() });
  plugin.register.mockResolvedValue(undefined);
  plugin.removeAllDeliveredNotifications.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('startMobilePush', () => {
  it('does nothing where push is unavailable', async () => {
    vi.mocked(canUseMobilePush).mockReturnValue(false);
    await startMobilePush('ws');
    expect(plugin.checkPermissions).not.toHaveBeenCalled();
  });

  it('asks once when permission was never asked', async () => {
    plugin.checkPermissions.mockResolvedValue({ receive: 'prompt' });
    await startMobilePush('ws');
    expect(plugin.requestPermissions).toHaveBeenCalledOnce();
    expect(plugin.register).toHaveBeenCalledOnce();
  });

  it('never registers after a refusal', async () => {
    plugin.checkPermissions.mockResolvedValue({ receive: 'denied' });
    await startMobilePush('ws');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
  });

  it('sends the token to the server for the open workspace', async () => {
    await startMobilePush('ws');
    deliverToken();
    expect(registerPushDevice).toHaveBeenCalledWith('ws', TOKEN);
  });
});

describe('stopMobilePush', () => {
  it('asks nothing of the server for a phone that never registered', async () => {
    await stopMobilePush();
    expect(unregisterPushDevice).not.toHaveBeenCalled();
  });

  it('lets go of the registered token and clears delivered notifications', async () => {
    await startMobilePush('ws');
    deliverToken();
    await vi.waitFor(() => {
      expect(localStorage.length).toBe(1);
    });
    await stopMobilePush();
    expect(unregisterPushDevice).toHaveBeenCalledWith('ws', TOKEN);
    await vi.waitFor(() => {
      expect(plugin.removeAllDeliveredNotifications).toHaveBeenCalledOnce();
    });
    expect(localStorage.length).toBe(0);
  });

  it('stops waiting when the server never answers', async () => {
    await startMobilePush('ws');
    deliverToken();
    await vi.waitFor(() => {
      expect(localStorage.length).toBe(1);
    });
    vi.mocked(unregisterPushDevice).mockReturnValue(
      new Promise<void>(() => undefined)
    );
    vi.useFakeTimers();
    const stopped = stopMobilePush();
    await vi.advanceTimersByTimeAsync(STOP_WAIT_MS);
    await expect(stopped).resolves.toBeUndefined();
  });
});
