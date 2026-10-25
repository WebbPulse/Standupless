/**
 * Tests for the Pulse page: entries newest first with their unread dot and
 * links, grouped under day headings, moved through with j/k and opened with
 * Enter, the read marker moved on view, the For me, Popular and Recent switch
 * kept in the URL, the empty states and older pages on request.
 */

import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PulseQuery } from '../../api/pulse';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import type {
  PulseItemRead,
  PulseListRead,
  PulseReadMarker,
  WorkspaceRead,
} from '../../types/Api';
import Pulse from './Pulse';

const listPulse =
  vi.fn<(workspaceId: string, query?: PulseQuery) => Promise<PulseListRead>>();
const markPulseRead =
  vi.fn<(workspaceId: string) => Promise<PulseReadMarker>>();

vi.mock('../../api/pulse', () => ({
  listPulse: (workspaceId: string, query?: PulseQuery) =>
    listPulse(workspaceId, query),
  markPulseRead: (workspaceId: string) => markPulseRead(workspaceId),
}));

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
  };
});

vi.mock('../../components/workspace/WorkspaceShell', () => ({
  default: ({
    title,
    actions,
    children,
  }: {
    title?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      {actions}
      {children}
    </main>
  ),
}));

const useWorkspaceMock = vi.fn<() => WorkspaceContextType>();

vi.mock('../../hooks/useWorkspace', () => ({
  useWorkspace: () => useWorkspaceMock(),
}));

/** A resolved workspace context. */
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

/** One feed entry: a project update unless overridden. */
const entry = (over: Partial<PulseItemRead> = {}): PulseItemRead => ({
  event_id: 'ev-1',
  workspace_id: 'ws-1',
  event_type: 'project_update',
  subject_type: 'project',
  project_id: 'p-1',
  project_name: 'Launch',
  project_icon: null,
  project_color: null,
  initiative_id: null,
  initiative_name: null,
  milestone_id: null,
  milestone_name: null,
  update_id: 'up-1',
  body: 'Slipping a week',
  health: 'at_risk',
  previous_health: null,
  actor_id: 'u-1',
  actor_name: 'Adam Admin',
  source: null,
  created_at: '2026-10-14T09:00:00Z',
  edited_at: null,
  unread: false,
  ...over,
});

/** A last page holding the given entries. */
const pageOf = (
  items: PulseItemRead[],
  next_cursor: string | null = null
): PulseListRead => ({ items, next_cursor });

/** Shows the current query string, so a test can read the tab from the URL. */
const SearchProbe = () => (
  <output data-testid="search">{useLocation().search}</output>
);

/** Renders the page on its route. */
const renderPage = (path = '/w/mine/pulse') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/w/:slug/pulse"
          element={
            <>
              <Pulse />
              <SearchProbe />
            </>
          }
        />
        <Route path="/w/:slug/projects/:id" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  listPulse.mockReset();
  markPulseRead.mockReset();
  markPulseRead.mockResolvedValue({ read_at: '2026-10-15T08:00:00Z' });
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
});

describe('the Pulse page', () => {
  it('lists the entries with who did what and links to the updates', async () => {
    listPulse.mockResolvedValue(
      pageOf([
        entry(),
        entry({
          event_id: 'ev-2',
          event_type: 'milestone_completed',
          update_id: null,
          body: null,
          health: null,
          actor_id: null,
          actor_name: '',
          milestone_id: 'm-1',
          milestone_name: 'Beta',
        }),
        entry({
          event_id: 'ev-3',
          event_type: 'initiative_update',
          subject_type: 'initiative',
          project_id: null,
          project_name: null,
          initiative_id: 'i-1',
          initiative_name: 'Growth',
          body: 'On track overall',
          health: 'on_track',
        }),
      ])
    );
    renderPage();

    const update = await screen.findByRole('article', {
      name: 'Launch: Adam Admin posted an update',
    });
    expect(within(update).getByText('Slipping a week')).toBeInTheDocument();
    expect(
      within(update).getByRole('link', { name: 'Launch' })
    ).toHaveAttribute('href', '/w/mine/projects/p-1?tab=updates');
    expect(
      screen.getByRole('article', { name: 'Launch: Beta was completed' })
    ).toBeInTheDocument();
    const initiative = screen.getByRole('article', {
      name: 'Growth: Adam Admin posted an update',
    });
    expect(
      within(initiative).getByRole('link', { name: 'Growth' })
    ).toHaveAttribute('href', '/w/mine/initiatives/i-1?tab=updates');
    expect(listPulse).toHaveBeenCalledWith('ws-1', { scope: 'for_me' });
  });

  it('marks unread entries and moves the read marker once', async () => {
    listPulse.mockResolvedValue(
      pageOf([entry({ unread: true }), entry({ event_id: 'ev-0' })])
    );
    renderPage();

    const entries = await screen.findAllByRole('article', {
      name: 'Launch: Adam Admin posted an update',
    });
    expect(entries).toHaveLength(2);
    expect(
      within(entries[0]!).getByRole('img', { name: 'Unread' })
    ).toBeInTheDocument();
    expect(
      within(entries[1]!).queryByRole('img', { name: 'Unread' })
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(markPulseRead).toHaveBeenCalledTimes(1);
    });
    expect(markPulseRead).toHaveBeenCalledWith('ws-1');
  });

  it('leaves the read marker alone when nothing is unread', async () => {
    listPulse.mockResolvedValue(pageOf([entry()]));
    renderPage();

    await screen.findByText('Slipping a week');
    expect(markPulseRead).not.toHaveBeenCalled();
  });

  it('switches to the recent feed', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([]));
    renderPage();

    expect(
      await screen.findByText(
        'No updates yet. Follow a project or initiative to see its updates here.'
      )
    ).toBeInTheDocument();
    const show = screen.getByRole('group', { name: 'Show' });
    expect(
      within(show).getByRole('button', { name: 'For me' })
    ).toHaveAttribute('aria-pressed', 'true');

    await user.click(within(show).getByRole('button', { name: 'Recent' }));

    expect(
      await screen.findByText('No project or initiative updates yet.')
    ).toBeInTheDocument();
    expect(listPulse).toHaveBeenCalledWith('ws-1', { scope: 'recent' });
    expect(
      within(show).getByRole('button', { name: 'Recent' })
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows For me, Popular and Recent in order and keeps the tab in the URL', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([]));
    renderPage();

    const show = screen.getByRole('group', { name: 'Show' });
    expect(
      within(show)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['For me', 'Popular', 'Recent']);

    await user.click(within(show).getByRole('button', { name: 'Popular' }));

    expect(
      await screen.findByText('No updates from the last two weeks yet.')
    ).toBeInTheDocument();
    expect(listPulse).toHaveBeenCalledWith('ws-1', { scope: 'popular' });
    expect(screen.getByTestId('search')).toHaveTextContent('?tab=popular');

    await user.click(within(show).getByRole('button', { name: 'For me' }));

    expect(screen.getByTestId('search')).toHaveTextContent(/^$/);
  });

  it('opens on the tab the URL names and lists popular entries without day headings', async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    listPulse.mockResolvedValue(
      pageOf([
        entry({ event_id: 'ev-1', created_at: yesterday.toISOString() }),
        entry({ event_id: 'ev-2', created_at: now.toISOString() }),
      ])
    );
    renderPage('/w/mine/pulse?tab=popular');

    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(listPulse).toHaveBeenCalledWith('ws-1', { scope: 'popular' });
    expect(
      within(screen.getByRole('group', { name: 'Show' })).getByRole('button', {
        name: 'Popular',
      })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.queryByRole('region', { name: 'Today' })
    ).not.toBeInTheDocument();
  });

  it('falls back to For me for a tab it does not know', async () => {
    listPulse.mockResolvedValue(pageOf([]));
    renderPage('/w/mine/pulse?tab=trending');

    await screen.findByText(
      'No updates yet. Follow a project or initiative to see its updates here.'
    );
    expect(listPulse).toHaveBeenCalledWith('ws-1', { scope: 'for_me' });
  });

  it('shows older entries on request', async () => {
    const user = userEvent.setup();
    listPulse.mockImplementation((_workspaceId, query) =>
      Promise.resolve(
        query?.cursor === 'older'
          ? pageOf([entry({ event_id: 'ev-0', body: 'Kicked off' })])
          : pageOf([entry()], 'older')
      )
    );
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Show older' }));

    expect(await screen.findByText('Kicked off')).toBeInTheDocument();
    expect(screen.getByText('Slipping a week')).toBeInTheDocument();
    expect(listPulse).toHaveBeenCalledWith('ws-1', {
      scope: 'for_me',
      cursor: 'older',
    });
    expect(
      screen.queryByRole('button', { name: 'Show older' })
    ).not.toBeInTheDocument();
  });

  it('groups entries under a heading for each day', async () => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    listPulse.mockResolvedValue(
      pageOf([
        entry({ event_id: 'ev-3', created_at: now.toISOString() }),
        entry({ event_id: 'ev-2', created_at: yesterday.toISOString() }),
        entry({ event_id: 'ev-1', created_at: yesterday.toISOString() }),
      ])
    );
    renderPage();

    const today = await screen.findByRole('region', { name: 'Today' });
    expect(within(today).getAllByRole('article')).toHaveLength(1);
    const before = screen.getByRole('region', { name: 'Yesterday' });
    expect(within(before).getAllByRole('article')).toHaveLength(2);
  });

  it('moves through entries with j and k and opens one with Enter', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(
      pageOf([
        entry({ event_id: 'ev-2', body: 'Second' }),
        entry({
          event_id: 'ev-1',
          event_type: 'project_health',
          project_id: 'p-2',
          body: null,
        }),
      ])
    );
    renderPage();

    const entries = await screen.findAllByRole('article');
    await user.keyboard('j');
    expect(entries[0]).toHaveAttribute('aria-current', 'true');
    await user.keyboard('j');
    expect(entries[1]).toHaveAttribute('aria-current', 'true');
    expect(entries[0]).not.toHaveAttribute('aria-current');
    await user.keyboard('k');
    await user.keyboard('j');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Project page')).toBeInTheDocument();
  });

  it('says when the feed cannot be read', async () => {
    listPulse.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
