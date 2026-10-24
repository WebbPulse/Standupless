/**
 * The inbox page. Covers above all that no read or write names a recipient,
 * since the partition is built from the session, plus that marking one row and
 * marking every row reach the shapes the contract fixes, and that opening a row
 * selects it, marks it read and shows its issue beside the list. Also covers
 * the keyboard: U toggles read and unread, H snoozes to a preset or a custom
 * moment, Backspace
 * removes and Shift R marks everything read, and Show snoozed with its
 * unsnooze. Opening a row while read rows are hidden keeps it open once it is
 * read. Notifications about one issue fold into one row that opens and marks
 * them all, and the Filter and Display menus shape the list query. The
 * actions menu deletes every read row or every row after a confirmation,
 * sending the current filter along. Removing and snoozing offer Undo: a
 * removal is held until its window lapses or the page goes, and undoing a
 * snooze unsnoozes and keeps read rows read. Each row's menu, from a right
 * click or its "more" button, offers the issue-only entries only on issue
 * rows, and unsubscribing from it, or with Shift S, offers Undo.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  NotificationListRead,
  NotificationRead,
  SubscribersRead,
  WorkspaceRead,
} from '../../types/Api';
import { fromLocalInput, toLocalInput } from '../../lib/reminders';
import {
  clearUndo,
  currentUndo,
  undoLast,
  UNDO_TOAST_MS,
} from '../../lib/undo';
import BoundKeys from '../../test/BoundKeys';
import { boundKeys, keysBound } from '../../test/shortcuts';
import Inbox from './Inbox';

const listInbox = vi.fn<(query: unknown) => Promise<NotificationListRead>>();
const markRead = vi.fn<(body: unknown) => Promise<number>>();
const markAllRead = vi.fn<() => Promise<number>>();
const deleteNotification = vi.fn<(id: string) => Promise<void>>();
const clearInbox = vi.fn<(body: unknown) => Promise<number>>();
const markUnread = vi.fn<(body: unknown) => Promise<number>>();
const snoozeNotifications =
  vi.fn<
    (body: { notification_ids: string[]; until: string }) => Promise<number>
  >();

const listSubscribers = vi.fn<(issueId: string) => Promise<SubscribersRead>>();
const subscribe = vi.fn<(issueId: string) => Promise<SubscribersRead>>();
const unsubscribe = vi.fn<(issueId: string) => Promise<SubscribersRead>>();

vi.mock('../../api/notifications', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/notifications')
  >('../../api/notifications');
  return {
    ...actual,
    listSubscribers: (_w: string, issueId: string) => listSubscribers(issueId),
    subscribe: (_w: string, issueId: string) => subscribe(issueId),
    unsubscribe: (_w: string, issueId: string) => unsubscribe(issueId),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: null,
    isLoading: false,
    isBusy: false,
    login: vi.fn(),
    logout: vi.fn(),
    checkAuthStatus: vi.fn(),
  }),
}));

vi.mock('../../api/views', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/views')>('../../api/views');
  return {
    ...actual,
    listInbox: (_w: string, query: unknown) => listInbox(query),
    markRead: (_w: string, body: unknown) => markRead(body),
    markAllRead: () => markAllRead(),
    deleteNotification: (_w: string, id: string) => deleteNotification(id),
    clearInbox: (_w: string, body: unknown) => clearInbox(body),
    markUnread: (_w: string, body: unknown) => markUnread(body),
    snoozeNotifications: (
      _w: string,
      body: { notification_ids: string[]; until: string }
    ) => snoozeNotifications(body),
  };
});

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

vi.mock('../../components/issues/IssuePane', () => ({
  default: ({ issueId, onClose }: { issueId: string; onClose: () => void }) => (
    <aside aria-label={`Peek ${issueId}`}>
      <button type="button" onClick={onClose}>
        Close peek
      </button>
    </aside>
  ),
}));

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** One notification in the shape the contract answers with. */
const notification = (
  over: Partial<NotificationRead> = {}
): NotificationRead => ({
  notification_id: 'n-1',
  workspace_id: 'ws-1',
  kind: 'mentioned',
  issue_id: 'iss-1',
  issue_key: 'ENG-1',
  issue_title: 'Cache the token',
  team_id: 'proj-1',
  comment_id: null,
  actor_id: 'user-2',
  actor_name: 'Grace',
  unread: true,
  created_at: '2026-09-17T00:00:00Z',
  expires_at: '2026-12-16T00:00:00Z',
  ...over,
});

/** A resolved workspace context, since the shell renders only once it is. */
const resolved = (): WorkspaceContextType => {
  const workspace: WorkspaceRead = {
    id: 'ws-1',
    name: 'Mine',
    slug: 'mine',
    plan: 'free',
    created_at: '2026-09-17T00:00:00Z',
    role: 'member',
  };
  return {
    workspace,
    isLoading: false,
    notFound: false,
    error: null,
    refresh: vi.fn(() => Promise.resolve()),
  };
};

/** Shows where the router is, so a test can read the selection. */
const Where = () => {
  const location = useLocation();
  return (
    <output aria-label="location">{`${location.pathname}${location.search}`}</output>
  );
};

const renderPage = (entry = '/w/mine/inbox') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ShortcutProvider>
        <BoundKeys />
        <Routes>
          <Route path="/w/:slug/inbox" element={<Inbox />} />
          <Route path="/w/:slug/issues/:key" element={<p>Issue page</p>} />
          <Route path="/w/:slug/projects/:id" element={<p>Project page</p>} />
        </Routes>
        <Where />
      </ShortcutProvider>
    </MemoryRouter>
  );

/** Dispatches one key the way the shortcut layer listens for it. */
const press = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, ...init })
    );
  });
};

/** Two unread notifications on two issues. */
const twoRows = () => ({
  notifications: [
    notification(),
    notification({
      notification_id: 'n-2',
      issue_id: 'iss-2',
      issue_key: 'ENG-2',
      issue_title: 'Retry the upload',
      kind: 'assigned',
    }),
  ],
  next_cursor: null,
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  clearUndo();
  listInbox.mockReset();
  markRead.mockReset();
  markAllRead.mockReset();
  deleteNotification.mockReset();
  clearInbox.mockReset();
  markUnread.mockReset();
  snoozeNotifications.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listInbox.mockResolvedValue({
    notifications: [notification()],
    next_cursor: null,
  });
  markRead.mockResolvedValue(1);
  markAllRead.mockResolvedValue(3);
  deleteNotification.mockResolvedValue(undefined);
  clearInbox.mockResolvedValue(2);
  markUnread.mockResolvedValue(1);
  snoozeNotifications.mockResolvedValue(1);
  listSubscribers.mockReset();
  subscribe.mockReset();
  unsubscribe.mockReset();
  listSubscribers.mockResolvedValue({ subscribers: [], subscribed: true });
  subscribe.mockResolvedValue({ subscribers: [], subscribed: true });
  unsubscribe.mockResolvedValue({ subscribers: [], subscribed: false });
});

describe('inbox', () => {
  it('lists the caller notifications', async () => {
    renderPage();

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(screen.getByText(/Mentioned you by Grace/)).toBeInTheDocument();
  });

  it('says when the change came through MCP', async () => {
    listInbox.mockResolvedValue({
      notifications: [notification({ source: 'mcp' })],
      next_cursor: null,
    });
    renderPage();

    expect(
      await screen.findByText(/Mentioned you by Grace via MCP/)
    ).toBeInTheDocument();
  });

  it('never names a recipient, since the partition is the session', async () => {
    renderPage();

    await waitFor(() => {
      expect(listInbox).toHaveBeenCalled();
    });
    const [query] = listInbox.mock.calls[0] ?? [];
    expect(query).not.toHaveProperty('user_id');
    expect(query).not.toHaveProperty('recipient_id');
  });

  it('filters to unread when read rows are hidden', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show read' }));

    await waitFor(() => {
      expect(listInbox).toHaveBeenCalledWith(
        expect.objectContaining({ unread: true })
      );
    });
  });

  it('marks one row read by id', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Mark ENG-1 read' })
    );

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
  });

  it('marks everything read in one call rather than row by row', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Inbox actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark all read' }));

    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalled();
    });
    expect(markRead).not.toHaveBeenCalled();
  });

  it('deletes every read row after a confirmation', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Inbox actions' }));
    await user.click(
      screen.getByRole('menuitem', { name: 'Delete all read notifications' })
    );
    expect(clearInbox).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete all read notifications',
    });
    listInbox.mockResolvedValue({ notifications: [], next_cursor: null });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(clearInbox).toHaveBeenCalledWith({ read_only: true });
    });
    await waitFor(() => {
      expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
    });
  });

  it('deletes every row under the current filter after a confirmation', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Comments' }));
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show snoozed' }));
    await user.click(screen.getByRole('button', { name: 'Inbox actions' }));
    await user.click(
      screen.getByRole('menuitem', { name: 'Delete all notifications' })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete all notifications',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(clearInbox).toHaveBeenCalledWith({
        read_only: false,
        include_snoozed: true,
        kinds: ['commented'],
      });
    });
  });

  it('deletes nothing when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Inbox actions' }));
    await user.click(
      screen.getByRole('menuitem', { name: 'Delete all notifications' })
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Delete all notifications',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(clearInbox).not.toHaveBeenCalled();
    expect(screen.getByText('Cache the token')).toBeInTheDocument();
  });

  it('selects a row, marks it read and shows its issue beside the list', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Cache the token/ })
    );

    expect(await screen.findByLabelText('Peek iss-1')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/w/mine/inbox?n=n-1'
    );
    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
  });

  it('does not mark an already read row again when it is selected', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [notification({ unread: false })],
      next_cursor: null,
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Cache the token/ })
    );

    expect(await screen.findByLabelText('Peek iss-1')).toBeInTheDocument();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('opens on the row the URL names', async () => {
    listInbox.mockResolvedValue(twoRows());
    renderPage('/w/mine/inbox?n=n-2');

    expect(await screen.findByLabelText('Peek iss-2')).toBeInTheDocument();
  });

  it('clears the selection when the pane closes', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/inbox?n=n-1');

    await user.click(await screen.findByRole('button', { name: 'Close peek' }));

    expect(screen.queryByLabelText('Peek iss-1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      /^\/w\/mine\/inbox$/
    );
    expect(
      screen.getByText('Select a notification to see its issue.')
    ).toBeInTheDocument();
  });

  it('closes the selected notification on escape', async () => {
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('escape');
    press('Escape');

    await waitFor(() => {
      expect(screen.queryByLabelText('Peek iss-1')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('location')).toHaveTextContent(
      /^\/w\/mine\/inbox$/
    );
  });

  it('moves through the rows with j and k', async () => {
    listInbox.mockResolvedValue(twoRows());
    renderPage();

    await screen.findByText('Retry the upload');
    await keysBound('j', 'k');
    press('j');
    expect(await screen.findByLabelText('Peek iss-1')).toBeInTheDocument();
    press('j');
    expect(await screen.findByLabelText('Peek iss-2')).toBeInTheDocument();
    press('k');
    expect(await screen.findByLabelText('Peek iss-1')).toBeInTheDocument();
    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-2'] });
    });
  });

  it('opens the full issue on enter', async () => {
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('enter');
    press('Enter');

    expect(await screen.findByText('Issue page')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/w/mine/issues/ENG-1'
    );
  });

  it('removes a notification, holding the delete until the page is left', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Remove ENG-1' })
    );

    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
    expect(currentUndo().at(-1)?.message).toBe('Removed ENG-1');
    expect(deleteNotification).not.toHaveBeenCalled();
    unmount();
    expect(deleteNotification).toHaveBeenCalledWith('n-1');
  });

  it('puts a removed notification back on undo without deleting it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Remove ENG-1' })
    );
    expect(screen.queryByText('Cache the token')).not.toBeInTheDocument();
    await act(async () => {
      await undoLast('ws-1');
    });

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    unmount();
    expect(deleteNotification).not.toHaveBeenCalled();
  });

  it('says so when the inbox is empty', async () => {
    listInbox.mockResolvedValue({ notifications: [], next_cursor: null });
    renderPage();

    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('says it once on a wide screen, in the pane rather than the list too', async () => {
    listInbox.mockResolvedValue({ notifications: [], next_cursor: null });
    renderPage();

    const list = await screen.findByText('Nothing here yet.');
    expect(list.closest('.lg\\:hidden')).not.toBeNull();
    expect(screen.getByText('You are all caught up.')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listInbox.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load your inbox.')
    ).toBeInTheDocument();
  });
  it('keeps snoozed rows in the list when Show snoozed is on', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    expect(listInbox).not.toHaveBeenCalledWith(
      expect.objectContaining({ include_snoozed: true })
    );
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show snoozed' }));

    await waitFor(() => {
      expect(listInbox).toHaveBeenCalledWith(
        expect.objectContaining({ include_snoozed: true })
      );
    });
    expect(
      screen.getByRole('checkbox', { name: 'Show snoozed' })
    ).toBeChecked();
  });

  it('asks for only the chosen notification types', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Status changes' }));
    await user.click(screen.getByRole('checkbox', { name: 'Comments' }));

    await waitFor(() => {
      expect(listInbox).toHaveBeenCalledWith(
        expect.objectContaining({ kind: ['commented', 'status_changed'] })
      );
    });
  });

  it('says so when a filter matches nothing', async () => {
    const user = userEvent.setup();
    listInbox.mockImplementation((query) =>
      Promise.resolve(
        (query as { kind?: string[] }).kind === undefined
          ? { notifications: [notification()], next_cursor: null }
          : { notifications: [], next_cursor: null }
      )
    );
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: /^Filter/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Reviews' }));

    expect(
      await screen.findAllByText('Nothing matches this filter.')
    ).not.toHaveLength(0);
  });

  it('remembers the view for the next visit', async () => {
    const user = userEvent.setup();
    const first = renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show read' }));
    first.unmount();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Display' }));
    expect(
      screen.getByRole('checkbox', { name: 'Show read' })
    ).not.toBeChecked();
    expect(
      screen.getByRole('checkbox', { name: 'Show snoozed' })
    ).not.toBeChecked();
  });

  it('folds notifications about one issue into one row with a count', async () => {
    listInbox.mockResolvedValue({
      notifications: [
        notification({
          notification_id: 'n-2',
          kind: 'status_changed',
          new_value: 'Done',
          summary: 'Grace moved to Done',
          created_at: '2026-09-18T00:00:00Z',
        }),
        notification(),
        notification({
          notification_id: 'n-3',
          issue_id: 'iss-2',
          issue_key: 'ENG-2',
          issue_title: 'Rotate the keys',
          summary: 'Ada commented',
          actor_name: 'Ada',
          kind: 'commented',
        }),
      ],
      next_cursor: null,
    });
    renderPage();

    expect(await screen.findByText('Grace moved to Done')).toBeInTheDocument();
    expect(screen.getAllByText('Cache the token')).toHaveLength(1);
    expect(screen.getByLabelText('2 notifications')).toBeInTheDocument();
    expect(screen.getByText('Ada commented')).toBeInTheDocument();
    expect(
      screen.queryByText(/Mentioned you by Grace/)
    ).not.toBeInTheDocument();
  });

  it('opens a folded row and marks every notification in it read', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [
        notification({ notification_id: 'n-2', kind: 'commented' }),
        notification(),
      ],
      next_cursor: null,
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Cache the token/ })
    );

    expect(await screen.findByLabelText('Peek iss-1')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/w/mine/inbox?n=n-2'
    );
    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({
        notification_ids: ['n-2', 'n-1'],
      });
    });
  });

  it('reads the server summary when there is one', async () => {
    listInbox.mockResolvedValue({
      notifications: [
        notification({
          kind: 'assigned',
          summary: 'Grace assigned you',
          source: 'mcp',
        }),
      ],
      next_cursor: null,
    });
    renderPage();

    expect(
      await screen.findByText('Grace assigned you via MCP')
    ).toBeInTheDocument();
  });

  it('marks the selected row read with u', async () => {
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('u');
    press('u');

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
    expect(markUnread).not.toHaveBeenCalled();
  });

  it('marks a read row unread with u', async () => {
    listInbox.mockResolvedValue({
      notifications: [notification({ unread: false })],
      next_cursor: null,
    });
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('u');
    press('u');

    await waitFor(() => {
      expect(markUnread).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
  });

  it('marks one row unread by id from its button', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [notification({ unread: false })],
      next_cursor: null,
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Mark ENG-1 unread' })
    );

    await waitFor(() => {
      expect(markUnread).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
  });

  it('snoozes the selected row to a preset with h', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('h');
    press('h');
    await user.click(
      await screen.findByRole('button', { name: /Tomorrow morning/ })
    );

    await waitFor(() => {
      expect(snoozeNotifications).toHaveBeenCalled();
    });
    const [body] = snoozeNotifications.mock.calls[0] ?? [];
    expect(body?.notification_ids).toEqual(['n-1']);
    expect(new Date(body?.until ?? '').getTime()).toBeGreaterThan(Date.now());
  });

  it('snoozes the selected row to a custom moment with h', async () => {
    const user = userEvent.setup();
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('h');
    press('h');
    const field = await screen.findByLabelText('Custom date and time');
    const moment = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    fireEvent.change(field, { target: { value: toLocalInput(moment) } });
    await user.click(screen.getByRole('button', { name: 'Snooze' }));

    await waitFor(() => {
      expect(snoozeNotifications).toHaveBeenCalled();
    });
    const [body] = snoozeNotifications.mock.calls[0] ?? [];
    expect(body?.notification_ids).toEqual(['n-1']);
    expect(body?.until).toBe(
      fromLocalInput(toLocalInput(moment))?.toISOString()
    );
  });

  it('shows when a snoozed row comes back', async () => {
    listInbox.mockResolvedValue({
      notifications: [
        notification({ unread: false, snoozed_until: '2026-12-01T17:00:00Z' }),
      ],
      next_cursor: null,
    });
    renderPage();

    expect(await screen.findByText(/Snoozed until/)).toBeInTheDocument();
  });

  it('keeps a row open while read rows are hidden after opening marks it read', async () => {
    const user = userEvent.setup();
    listInbox.mockImplementation((query) =>
      Promise.resolve(
        markRead.mock.calls.length > 0 &&
          (query as { unread?: boolean }).unread === true
          ? { notifications: [], next_cursor: null }
          : { notifications: [notification()], next_cursor: null }
      )
    );
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByRole('button', { name: 'Display' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show read' }));
    await user.keyboard('{Escape}');
    await user.click(
      await screen.findByRole('button', { name: /Cache the token/ })
    );

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
    const readAt = markRead.mock.invocationCallOrder[0] ?? 0;
    await waitFor(() => {
      const refetched = listInbox.mock.calls.some(
        ([query], index) =>
          (query as { unread?: boolean }).unread === true &&
          (listInbox.mock.invocationCallOrder[index] ?? 0) > readAt
      );
      expect(refetched).toBe(true);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Peek iss-1')).toBeInTheDocument();
    expect(screen.getByText('Cache the token')).toBeInTheDocument();
  });

  it('unsnoozes a snoozed row from the snooze menu', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [
        notification({ unread: false, snoozed_until: '2026-12-01T17:00:00Z' }),
      ],
      next_cursor: null,
    });
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('h');
    press('h');
    await user.click(
      await screen.findByRole('button', { name: 'Unsnooze now' })
    );

    await waitFor(() => {
      expect(markUnread).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
    expect(snoozeNotifications).not.toHaveBeenCalled();
  });

  it('offers no unsnooze for a row that is not snoozed', async () => {
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('h');
    press('h');

    expect(
      await screen.findByRole('button', { name: /Tomorrow morning/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Unsnooze now' })
    ).not.toBeInTheDocument();
  });

  it('removes the selected row with backspace once the undo window lapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('backspace');
    press('Backspace');

    expect(deleteNotification).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(UNDO_TOAST_MS);
    });
    await waitFor(() => {
      expect(deleteNotification).toHaveBeenCalledWith('n-1');
    });
  });

  it('unsnoozes on undo and keeps a read row read', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [notification({ unread: false })],
      next_cursor: null,
    });
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('h');
    press('h');
    await user.click(
      await screen.findByRole('button', { name: /Tomorrow morning/ })
    );
    await waitFor(() => {
      expect(snoozeNotifications).toHaveBeenCalled();
    });
    expect(currentUndo().at(-1)?.message).toBe('Snoozed ENG-1');
    await act(async () => {
      await undoLast('ws-1');
    });

    expect(markUnread).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
  });

  it('names the project on a project update row and links to its updates', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [
        notification({
          notification_id: 'n-9',
          kind: 'project_update',
          issue_id: '',
          issue_key: '',
          issue_title: '',
          project_id: 'prj-1',
          project_name: 'Public beta',
          project_update_id: 'upd-1',
        }),
      ],
      next_cursor: null,
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /^Public beta/ })
    );

    expect(
      await screen.findByRole('complementary', { name: 'Project update' })
    ).toHaveTextContent('Grace posted an update on Public beta');
    expect(screen.queryByLabelText(/^Peek/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mark Public beta unread' })
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Open project updates' })
    );

    expect(await screen.findByText('Project page')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/w/mine/projects/prj-1?tab=updates'
    );
  });

  it('shows a review request and opens its pull request on enter', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    listInbox.mockResolvedValue({
      notifications: [
        notification({
          notification_id: 'n-7',
          kind: 'review_requested',
          issue_id: '',
          issue_key: 'acme/api#42',
          issue_title: 'Refactor the parser',
          url: 'https://github.com/acme/api/pull/42',
        }),
      ],
      next_cursor: null,
    });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: /Refactor the parser/ })
    );

    expect(
      await screen.findByRole('complementary', { name: 'Review request' })
    ).toHaveTextContent('requested your review on Refactor the parser');
    expect(screen.queryByLabelText(/^Peek/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open the pull request' })
    ).toBeInTheDocument();

    await keysBound('enter');
    press('Enter');

    expect(open).toHaveBeenCalledWith(
      'https://github.com/acme/api/pull/42',
      '_blank',
      'noopener,noreferrer'
    );
    open.mockRestore();
  });

  it('marks everything read with shift r', async () => {
    renderPage();

    await screen.findByText('Cache the token');
    await keysBound('shift+r');
    press('R', { shiftKey: true });

    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalled();
    });
  });
});

/** A project update row, which is not about an issue. */
const projectRow = () =>
  notification({
    notification_id: 'n-9',
    kind: 'project_update',
    issue_id: '',
    issue_key: '',
    issue_title: '',
    project_id: 'prj-1',
    project_name: 'Public beta',
    project_update_id: 'upd-1',
  });

/** Right clicks the row holding `text` and answers the menu it opens. */
const openRowMenu = async (text: string): Promise<HTMLElement> => {
  const label = await screen.findByText(text);
  const row = label.closest('li');
  if (row === null) throw new Error('no row');
  fireEvent.contextMenu(row, { clientX: 20, clientY: 20 });
  return screen.findByRole('menu');
};

describe('inbox row menu', () => {
  it('offers every entry on an issue row', async () => {
    renderPage();

    const menu = await openRowMenu('Cache the token');

    const names = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(names).toEqual([
      expect.stringContaining('Mark as read'),
      expect.stringContaining('Snooze'),
      expect.stringContaining('Delete notification'),
      expect.stringContaining('Unsubscribe from issue'),
      'Copy issue link',
      'Open in new tab',
    ]);
  });

  it('leaves the issue-only entries off a project update row', async () => {
    listInbox.mockResolvedValue({
      notifications: [projectRow()],
      next_cursor: null,
    });
    renderPage();

    const menu = await openRowMenu('Public beta');

    expect(
      within(menu).getByRole('menuitem', { name: /Mark as read/ })
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: /Unsubscribe/ })
    ).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Copy issue link' })
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'Open in new tab' })
    ).toBeInTheDocument();
    expect(listSubscribers).not.toHaveBeenCalled();
  });

  it('offers to subscribe when the caller does not follow the issue', async () => {
    listSubscribers.mockResolvedValue({ subscribers: [], subscribed: false });
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu('Cache the token');
    await user.click(
      await within(menu).findByRole('menuitem', { name: /Subscribe to issue/ })
    );

    await waitFor(() => {
      expect(subscribe).toHaveBeenCalledWith('iss-1');
    });
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('opens the same menu from the row more button', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'More actions for ENG-1' })
    );

    expect(
      await screen.findByRole('menuitem', { name: /Unsubscribe from issue/ })
    ).toBeInTheDocument();
  });

  it('unsubscribes from the menu and resubscribes on undo', async () => {
    const user = userEvent.setup();
    renderPage();

    const menu = await openRowMenu('Cache the token');
    await user.click(
      within(menu).getByRole('menuitem', { name: /Unsubscribe from issue/ })
    );

    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledWith('iss-1');
    });
    await waitFor(() => {
      expect(currentUndo().at(-1)?.message).toBe('Unsubscribed from ENG-1');
    });
    await act(async () => {
      await undoLast('ws-1');
    });

    expect(subscribe).toHaveBeenCalledWith('iss-1');
  });

  it('opens a row in a new tab', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPage();

    const menu = await openRowMenu('Cache the token');
    await user.click(
      within(menu).getByRole('menuitem', { name: 'Open in new tab' })
    );

    expect(open).toHaveBeenCalledWith(
      `${window.location.origin}/w/mine/issues/ENG-1`,
      '_blank',
      'noopener,noreferrer'
    );
    open.mockRestore();
  });

  it('toggles the subscription on the selected row with shift s', async () => {
    renderPage('/w/mine/inbox?n=n-1');

    await screen.findByLabelText('Peek iss-1');
    await keysBound('shift+s');
    press('S', { shiftKey: true });

    await waitFor(() => {
      expect(unsubscribe).toHaveBeenCalledWith('iss-1');
    });
    await waitFor(() => {
      expect(currentUndo().at(-1)?.message).toBe('Unsubscribed from ENG-1');
    });
  });

  it('does not bind shift s on a row with no issue', async () => {
    listInbox.mockResolvedValue({
      notifications: [projectRow()],
      next_cursor: null,
    });
    renderPage('/w/mine/inbox?n=n-9');

    await screen.findByRole('complementary', { name: 'Project update' });
    await keysBound('enter');

    expect(boundKeys()).not.toContain('shift+s');
  });
});
