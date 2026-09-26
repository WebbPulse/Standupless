/**
 * The inbox page. Covers above all that no read or write names a recipient,
 * since the partition is built from the session, plus that marking one row and
 * marking every row reach the shapes the contract fixes, and that opening a row
 * selects it, marks it read and shows its issue beside the list.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  NotificationListRead,
  NotificationRead,
  WorkspaceRead,
} from '../../types/Api';
import Inbox from './Inbox';

const listInbox = vi.fn<(query: unknown) => Promise<NotificationListRead>>();
const markRead = vi.fn<(body: unknown) => Promise<number>>();
const markAllRead = vi.fn<() => Promise<number>>();
const deleteNotification = vi.fn<(id: string) => Promise<void>>();

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

vi.mock('../../components/issues/IssuePeek', () => ({
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
        <Routes>
          <Route path="/w/:slug/inbox" element={<Inbox />} />
          <Route path="/w/:slug/issues/:key" element={<p>Issue page</p>} />
        </Routes>
        <Where />
      </ShortcutProvider>
    </MemoryRouter>
  );

/** Dispatches one key the way the shortcut layer listens for it. */
const press = (key: string) => {
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true })
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

beforeEach(() => {
  listInbox.mockReset();
  markRead.mockReset();
  markAllRead.mockReset();
  deleteNotification.mockReset();
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  listInbox.mockResolvedValue({
    notifications: [notification()],
    next_cursor: null,
  });
  markRead.mockResolvedValue(1);
  markAllRead.mockResolvedValue(3);
  deleteNotification.mockResolvedValue(undefined);
});

describe('inbox', () => {
  it('lists the caller notifications', async () => {
    renderPage();

    expect(await screen.findByText('Cache the token')).toBeInTheDocument();
    expect(screen.getByText(/Mentioned you by Grace/)).toBeInTheDocument();
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

  it('filters to unread when asked', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Cache the token');
    await user.click(screen.getByLabelText('Unread only'));

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
    await user.click(screen.getByRole('button', { name: 'Mark all read' }));

    await waitFor(() => {
      expect(markAllRead).toHaveBeenCalled();
    });
    expect(markRead).not.toHaveBeenCalled();
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

  it('moves through the rows with j and k', async () => {
    listInbox.mockResolvedValue(twoRows());
    renderPage();

    await screen.findByText('Retry the upload');
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
    press('Enter');

    expect(await screen.findByText('Issue page')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent(
      '/w/mine/issues/ENG-1'
    );
  });

  it('removes a notification', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Remove ENG-1' })
    );

    await waitFor(() => {
      expect(deleteNotification).toHaveBeenCalledWith('n-1');
    });
  });

  it('says so when the inbox is empty', async () => {
    listInbox.mockResolvedValue({ notifications: [], next_cursor: null });
    renderPage();

    expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('surfaces a failed read', async () => {
    listInbox.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(
      await screen.findByText('Could not load your inbox.')
    ).toBeInTheDocument();
  });
});
