/**
 * The desktop notifications block in notification settings. It shows the
 * browser permission, asks for it from the Enable button, keeps its switch on
 * this device, explains how to re-allow a block, and defers to the desktop app.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  readDesktopNotificationsEnabled,
} from '../../lib/desktopNotifications';
import DesktopNotificationsSettings from './DesktopNotificationsSettings';

/** A stand-in for the browser's Notification API. */
const stubNotification = (
  permission: NotificationPermission,
  answer: NotificationPermission = permission
) => {
  const requestPermission = vi.fn(() => Promise.resolve(answer));
  vi.stubGlobal('Notification', { permission, requestPermission });
  return requestPermission;
};

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('DesktopNotificationsSettings', () => {
  it('asks for permission and turns the switch on when allowed', async () => {
    const requestPermission = stubNotification('default', 'granted');
    render(<DesktopNotificationsSettings />);
    expect(screen.getByTestId('desktop-permission').textContent).toContain(
      'Not asked yet'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    expect(requestPermission).toHaveBeenCalledTimes(1);
    const toggle = await screen.findByRole('checkbox', {
      name: 'Show desktop notifications on this device',
    });
    expect(toggle).toBeChecked();
    expect(screen.getByTestId('desktop-permission').textContent).toContain(
      'Allowed'
    );
    expect(readDesktopNotificationsEnabled()).toBe(true);
  });

  it('keeps the switch off when the browser refuses', async () => {
    stubNotification('default', 'denied');
    render(<DesktopNotificationsSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() =>
      expect(screen.getByTestId('desktop-permission').textContent).toContain(
        'Blocked'
      )
    );
    expect(readDesktopNotificationsEnabled()).toBe(false);
  });

  it('stores the switch on this device when permission is granted', () => {
    stubNotification('granted');
    globalThis.localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, 'on');
    render(<DesktopNotificationsSettings />);
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    const toggle = screen.getByRole('checkbox', {
      name: 'Show desktop notifications on this device',
    });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(
      globalThis.localStorage.getItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY)
    ).toBe('off');
  });

  it('explains how to re-allow a blocked permission', () => {
    stubNotification('denied');
    render(<DesktopNotificationsSettings />);
    expect(screen.getByTestId('desktop-permission').textContent).toContain(
      'Blocked'
    );
    expect(
      screen.getByText(/set Notifications to Allow, then reload this page/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says when the browser has no notifications', () => {
    render(<DesktopNotificationsSettings />);
    expect(
      screen.getByText('This browser cannot show desktop notifications.')
    ).toBeInTheDocument();
  });

  it('defers to the desktop app inside it', () => {
    stubNotification('default');
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      setBadgeCount: () => undefined,
    };
    render(<DesktopNotificationsSettings />);
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull();
    expect(screen.getByText(/The desktop app shows/)).toBeInTheDocument();
  });
});
