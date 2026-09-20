/**
 * The inbox page. Covers above all that no read or write names a recipient,
 * since the partition is built from the session, plus that marking one row and
 * marking every row reach the shapes the contract fixes, and that opening a row
 * marks it read on the way to the issue.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  project_id: 'proj-1',
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

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/w/mine/inbox']}>
      <Routes>
        <Route path="/w/:slug/inbox" element={<Inbox />} />
      </Routes>
    </MemoryRouter>
  );

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
    expect(screen.getByText('Mentioned you')).toBeInTheDocument();
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

  it('marks a row read on the way to its issue', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('link', { name: /ENG-1/ }));

    await waitFor(() => {
      expect(markRead).toHaveBeenCalledWith({ notification_ids: ['n-1'] });
    });
  });

  it('does not mark an already read row again when it is opened', async () => {
    const user = userEvent.setup();
    listInbox.mockResolvedValue({
      notifications: [notification({ unread: false })],
      next_cursor: null,
    });
    renderPage();

    await user.click(await screen.findByRole('link', { name: /ENG-1/ }));

    expect(markRead).not.toHaveBeenCalled();
  });

  it('links a row at the workspace key route', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: /ENG-1/ })).toHaveAttribute(
      'href',
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
