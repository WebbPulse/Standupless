/**
 * The browser desktop notifications for new inbox rows. The first read on a
 * device only marks where to start, a later rise notifies each new row once,
 * a burst collapses into one summary, a focused tab and the desktop app stay
 * quiet, a pause holds them back unless a direct mention may break through,
 * and clicking a notification opens the issue.
 */

import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { NotificationRead, WorkspaceRead } from '../types/Api';
import {
  DESKTOP_NOTIFICATIONS_STORAGE_KEY,
  notifiedMarkKey,
  readNotifiedMark,
} from '../lib/desktopNotifications';
import { useDesktopNotifications } from './useDesktopNotifications';

const counts = new Map<string, number | null>();
const listInbox =
  vi.fn<
    (
      workspaceId: string,
      query: unknown
    ) => Promise<{ notifications: NotificationRead[]; next_cursor: null }>
  >();

const auth: { user: Record<string, unknown> | null } = { user: null };

vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: auth.user }),
}));

vi.mock('./useSidebarData', () => ({
  useInboxCount: (workspaceId: string) => counts.get(workspaceId) ?? null,
}));

vi.mock('../api/views', () => ({
  listInbox: (workspaceId: string, query: unknown) =>
    listInbox(workspaceId, query),
}));

/** One shown notification, as the stub records it. */
interface Shown {
  title: string;
  body: string;
  tag: string;
  onclick: (() => void) | null;
  close: () => void;
}

const shown: Shown[] = [];

/** A stand-in for the browser's Notification constructor. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn(() =>
    Promise.resolve(FakeNotification.permission)
  );
  title: string;
  body: string;
  tag: string;
  onclick: (() => void) | null = null;
  close = vi.fn();

  constructor(title: string, options: { body: string; tag: string }) {
    this.title = title;
    this.body = options.body;
    this.tag = options.tag;
    shown.push(this);
  }
}

/** An unread inbox row about issue `key`, created at `at`. */
const row = (id: string, at: string, key = 'ENG-1'): NotificationRead => ({
  notification_id: id,
  workspace_id: 'ws',
  kind: 'commented',
  issue_id: `issue-${id}`,
  issue_key: key,
  issue_title: 'Fix the login page',
  team_id: 'team',
  comment_id: null,
  actor_id: 'u-2',
  actor_name: 'Olive',
  unread: true,
  summary: 'Olive commented',
  created_at: at,
  expires_at: '2027-01-01T00:00:00Z',
});

/** Mounts the hook for a workspace and shows the current path. */
const Harness: React.FC<{ id: string }> = ({ id }) => {
  useDesktopNotifications({ id, slug: 'acme' } as WorkspaceRead);
  const location = useLocation();
  return <p data-testid="path">{location.pathname}</p>;
};

/** Renders the harness under a router. */
const mount = (id: string) =>
  render(
    <MemoryRouter initialEntries={['/w/acme/inbox']}>
      <Routes>
        <Route path="*" element={<Harness id={id} />} />
      </Routes>
    </MemoryRouter>
  );

/** Lets the inbox read and its notifications settle. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

let hasFocus: MockInstance<() => boolean>;

beforeEach(() => {
  auth.user = null;
  shown.length = 0;
  counts.clear();
  listInbox.mockReset();
  FakeNotification.permission = 'granted';
  vi.stubGlobal('Notification', FakeNotification);
  globalThis.localStorage.clear();
  globalThis.localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, 'on');
  hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  hasFocus.mockRestore();
  delete (window as { standuplessDesktop?: unknown }).standuplessDesktop;
});

describe('useDesktopNotifications', () => {
  it('shows nothing while paused but still moves the mark', async () => {
    auth.user = {
      notifications_paused_until: new Date(Date.now() + 3600_000).toISOString(),
    };
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-paused'),
      JSON.stringify({ id: 'n1', at: '2026-10-25T10:00:01Z' })
    );
    counts.set('ws-paused', 1);
    listInbox.mockResolvedValue({
      notifications: [row('n2', '2026-10-25T10:00:02Z')],
      next_cursor: null,
    });
    mount('ws-paused');
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    await settle();
    expect(shown).toHaveLength(0);
    expect(readNotifiedMark('ws-paused')?.id).toBe('n2');
  });

  it('lets a direct mention through a pause when urgent ones may pass', async () => {
    auth.user = {
      notifications_paused_until: new Date(Date.now() + 3600_000).toISOString(),
      urgent_bypasses_pause: true,
    };
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-mention'),
      JSON.stringify({ id: 'n1', at: '2026-10-25T10:00:01Z' })
    );
    counts.set('ws-mention', 2);
    listInbox.mockResolvedValue({
      notifications: [
        { ...row('n3', '2026-10-25T10:00:03Z', 'ENG-3'), kind: 'mentioned' },
        row('n2', '2026-10-25T10:00:02Z', 'ENG-2'),
      ],
      next_cursor: null,
    });
    mount('ws-mention');
    await waitFor(() => expect(shown).toHaveLength(1));
    await settle();
    expect(shown).toHaveLength(1);
    expect(shown[0]?.tag).toBe('n3');
  });

  it('only marks where to start on the first read on a device', async () => {
    counts.set('ws-first', 2);
    listInbox.mockResolvedValue({
      notifications: [
        row('n2', '2026-10-25T10:00:02Z'),
        row('n1', '2026-10-25T10:00:01Z'),
      ],
      next_cursor: null,
    });
    mount('ws-first');
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    await settle();
    expect(shown).toHaveLength(0);
    expect(readNotifiedMark('ws-first')).toEqual({
      id: 'n2',
      at: '2026-10-25T10:00:02Z',
    });
  });

  it('notifies each new row once and not again after a reload', async () => {
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-dedupe'),
      JSON.stringify({ id: 'n1', at: '2026-10-25T10:00:01Z' })
    );
    counts.set('ws-dedupe', 2);
    listInbox.mockResolvedValue({
      notifications: [
        row('n2', '2026-10-25T10:00:02Z', 'ENG-2'),
        row('n1', '2026-10-25T10:00:01Z'),
      ],
      next_cursor: null,
    });
    const view = mount('ws-dedupe');
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toMatchObject({
      title: 'ENG-2 Fix the login page',
      body: 'Olive commented',
      tag: 'n2',
    });

    view.unmount();
    counts.set('ws-dedupe', 3);
    mount('ws-dedupe');
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(2));
    await settle();
    expect(shown).toHaveLength(1);
  });

  it('collapses a burst into one summary', async () => {
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-burst'),
      JSON.stringify({ id: 'n0', at: '2026-10-25T10:00:00Z' })
    );
    counts.set('ws-burst', 5);
    listInbox.mockResolvedValue({
      notifications: [5, 4, 3, 2, 1].map((n) =>
        row(`n${n}`, `2026-10-25T10:00:0${n}Z`)
      ),
      next_cursor: null,
    });
    mount('ws-burst');
    await waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toMatchObject({
      title: 'Standupless',
      body: '5 new notifications in your inbox',
    });
  });

  it('only moves the mark while the tab is focused', async () => {
    hasFocus.mockReturnValue(true);
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-focused'),
      JSON.stringify({ id: 'n1', at: '2026-10-25T10:00:01Z' })
    );
    counts.set('ws-focused', 1);
    listInbox.mockResolvedValue({
      notifications: [row('n2', '2026-10-25T10:00:02Z')],
      next_cursor: null,
    });
    mount('ws-focused');
    await waitFor(() => expect(listInbox).toHaveBeenCalledTimes(1));
    await settle();
    expect(shown).toHaveLength(0);
    expect(readNotifiedMark('ws-focused')?.id).toBe('n2');
  });

  it('stays quiet inside the desktop app', async () => {
    (window as { standuplessDesktop?: unknown }).standuplessDesktop = {
      setBadgeCount: () => undefined,
      notify: () => undefined,
    };
    counts.set('ws-desktop', 3);
    mount('ws-desktop');
    await settle();
    expect(listInbox).not.toHaveBeenCalled();
    expect(shown).toHaveLength(0);
  });

  it('stays quiet when the switch is off or permission is not granted', async () => {
    globalThis.localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, 'off');
    counts.set('ws-off', 3);
    const view = mount('ws-off');
    await settle();
    view.unmount();
    globalThis.localStorage.setItem(DESKTOP_NOTIFICATIONS_STORAGE_KEY, 'on');
    FakeNotification.permission = 'denied';
    mount('ws-off');
    await settle();
    expect(listInbox).not.toHaveBeenCalled();
  });

  it('focuses the window and opens the issue on click', async () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    globalThis.localStorage.setItem(
      notifiedMarkKey('ws-click'),
      JSON.stringify({ id: 'n1', at: '2026-10-25T10:00:01Z' })
    );
    counts.set('ws-click', 1);
    listInbox.mockResolvedValue({
      notifications: [row('n2', '2026-10-25T10:00:02Z', 'ENG-7')],
      next_cursor: null,
    });
    mount('ws-click');
    await waitFor(() => expect(shown).toHaveLength(1));
    act(() => {
      shown[0]?.onclick?.();
    });
    expect(focus).toHaveBeenCalled();
    expect(shown[0]?.close).toHaveBeenCalled();
    expect(screen.getByTestId('path').textContent).toBe('/w/acme/issues/ENG-7');
    focus.mockRestore();
  });
});
