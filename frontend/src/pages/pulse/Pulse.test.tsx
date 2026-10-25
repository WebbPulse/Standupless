/**
 * Tests for the Pulse page: entries newest first with their unread dot and
 * links, grouped under day headings, moved through with j/k and opened with
 * Enter, the read marker moved on view, the For me, Popular and Recent switch
 * kept in the URL, the empty states and older pages on request, and each
 * entry's menu following or unfollowing what it is about.
 */

import type { ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowSubject, PulseQuery } from '../../api/pulse';
import ShortcutProvider from '../../components/shortcuts/ShortcutProvider';
import type { WorkspaceContextType } from '../../contexts/WorkspaceContextDefinition';
import { clearToasts, currentToasts } from '../../lib/toast';
import type {
  PulseFollowRead,
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
const getFollow =
  vi.fn<
    (
      workspaceId: string,
      subject: FollowSubject,
      subjectId: string
    ) => Promise<PulseFollowRead>
  >();
const setFollow =
  vi.fn<
    (
      workspaceId: string,
      subject: FollowSubject,
      subjectId: string,
      following: boolean
    ) => Promise<PulseFollowRead>
  >();

vi.mock('../../api/pulse', () => ({
  listPulse: (workspaceId: string, query?: PulseQuery) =>
    listPulse(workspaceId, query),
  markPulseRead: (workspaceId: string) => markPulseRead(workspaceId),
  getFollow: (workspaceId: string, subject: FollowSubject, subjectId: string) =>
    getFollow(workspaceId, subject, subjectId),
  setFollow: (
    workspaceId: string,
    subject: FollowSubject,
    subjectId: string,
    following: boolean
  ) => setFollow(workspaceId, subject, subjectId, following),
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

/** The page and its probe, inside the shortcut registry when asked. */
const page = (withShortcuts: boolean): ReactNode => {
  const body = (
    <>
      <Pulse />
      <SearchProbe />
    </>
  );
  return withShortcuts ? <ShortcutProvider>{body}</ShortcutProvider> : body;
};

/** Renders the page on its route. */
const renderPage = (path = '/w/mine/pulse', withShortcuts = false) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/w/:slug/pulse" element={page(withShortcuts)} />
        <Route path="/w/:slug/projects/:id" element={<p>Project page</p>} />
      </Routes>
    </MemoryRouter>
  );

/** An initiative update entry. */
const initiativeEntry = (over: Partial<PulseItemRead> = {}): PulseItemRead =>
  entry({
    event_id: 'ev-9',
    event_type: 'initiative_update',
    subject_type: 'initiative',
    project_id: null,
    project_name: null,
    initiative_id: 'i-1',
    initiative_name: 'Growth',
    body: 'On track overall',
    health: 'on_track',
    ...over,
  });

/** Runs the newest notice's button, as pressing Undo on it would. */
const runLatestToastAction = (): void => {
  const action = currentToasts().at(-1)?.action;
  if (action === undefined || !('run' in action)) {
    throw new Error('No toast button to run');
  }
  act(() => {
    action.run();
  });
};

beforeEach(() => {
  listPulse.mockReset();
  markPulseRead.mockReset();
  markPulseRead.mockResolvedValue({ read_at: '2026-10-15T08:00:00Z' });
  useWorkspaceMock.mockReset();
  useWorkspaceMock.mockReturnValue(resolved());
  getFollow.mockReset();
  getFollow.mockResolvedValue({ following: true, explicit: true });
  setFollow.mockReset();
  setFollow.mockImplementation((_w, _s, _i, following) =>
    Promise.resolve({ following, explicit: true })
  );
  clearToasts();
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

  it('lists what the feed is about beside it, newest first with its latest health', async () => {
    listPulse.mockResolvedValue(
      pageOf([
        entry({
          event_id: 'ev-3',
          event_type: 'milestone_completed',
          update_id: null,
          body: null,
          health: null,
          milestone_id: 'm-1',
          milestone_name: 'Beta',
        }),
        initiativeEntry(),
        entry({ event_id: 'ev-1' }),
      ])
    );
    renderPage();

    const panel = await screen.findByRole('complementary', {
      name: 'In this feed',
    });
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(
      within(rows[0]!).getByRole('link', { name: 'Launch' })
    ).toHaveAttribute('href', '/w/mine/projects/p-1');
    expect(within(rows[0]!).getByText('At risk')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2 entries')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole('link', { name: 'Growth' })
    ).toHaveAttribute('href', '/w/mine/initiatives/i-1');
    expect(within(rows[1]!).getByText('On track')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('1 entry')).toBeInTheDocument();
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

describe('the Pulse entry menu', () => {
  it('unfollows a project, drops its entries at once and follows it again on Undo', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(
      pageOf([
        entry({ event_id: 'ev-2', body: 'Second' }),
        initiativeEntry(),
        entry({ event_id: 'ev-1', body: 'First' }),
      ])
    );
    renderPage();

    await user.click(
      (await screen.findAllByRole('button', { name: 'Actions for Launch' }))[0]!
    );
    const menu = screen.getByRole('menu', { name: 'Launch actions' });
    await user.click(
      await within(menu).findByRole('menuitem', { name: 'Unfollow project' })
    );

    expect(getFollow).toHaveBeenCalledWith('ws-1', 'project', 'p-1');
    expect(setFollow).toHaveBeenCalledWith('ws-1', 'project', 'p-1', false);
    expect(screen.queryByText('Second')).not.toBeInTheDocument();
    expect(screen.queryByText('First')).not.toBeInTheDocument();
    expect(screen.getByText('On track overall')).toBeInTheDocument();
    await waitFor(() => {
      expect(currentToasts().at(-1)?.message).toBe('Unfollowed Launch');
    });

    runLatestToastAction();

    expect(setFollow).toHaveBeenLastCalledWith('ws-1', 'project', 'p-1', true);
    expect(await screen.findByText('Second')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('brings the entries back when the unfollow fails', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([entry()]));
    setFollow.mockRejectedValue(new Error('boom'));
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Launch' })
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Unfollow project' })
    );

    expect(await screen.findByText('Slipping a week')).toBeInTheDocument();
    expect(currentToasts().at(-1)?.tone).toBe('error');
  });

  it('offers Unfollow initiative and says when the follow comes from a role', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([initiativeEntry()]));
    getFollow.mockResolvedValue({ following: true, explicit: false });
    renderPage();

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Growth' })
    );

    const menu = screen.getByRole('menu', { name: 'Growth actions' });
    expect(
      await within(menu).findByRole('menuitem', {
        name: 'Unfollow initiative',
      })
    ).toBeInTheDocument();
    expect(
      within(menu).getByText('You follow this initiative because you own it.')
    ).toBeInTheDocument();
    expect(getFollow).toHaveBeenCalledWith('ws-1', 'initiative', 'i-1');
  });

  it('hides Unfollow and says why when the caller does not follow the source', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([entry()]));
    getFollow.mockResolvedValue({ following: false, explicit: false });
    renderPage('/w/mine/pulse?tab=recent');

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Launch' })
    );

    const menu = screen.getByRole('menu', { name: 'Launch actions' });
    expect(
      await within(menu).findByText(
        'You do not follow this project. It shows here because you can see it.'
      )
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Unfollow project' })
    ).not.toBeInTheDocument();

    await user.click(
      within(menu).getByRole('menuitem', { name: 'Follow project' })
    );

    expect(setFollow).toHaveBeenCalledWith('ws-1', 'project', 'p-1', true);
    expect(screen.getByText('Slipping a week')).toBeInTheDocument();
  });

  it('keeps entries on Recent after an unfollow', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(pageOf([entry()]));
    renderPage('/w/mine/pulse?tab=recent');

    await user.click(
      await screen.findByRole('button', { name: 'Actions for Launch' })
    );
    await user.click(
      await screen.findByRole('menuitem', { name: 'Unfollow project' })
    );

    expect(setFollow).toHaveBeenCalledWith('ws-1', 'project', 'p-1', false);
    expect(screen.getByText('Slipping a week')).toBeInTheDocument();
  });

  it('opens the highlighted entry menu from the keyboard', async () => {
    const user = userEvent.setup();
    listPulse.mockResolvedValue(
      pageOf([entry({ event_id: 'ev-2' }), initiativeEntry()])
    );
    renderPage('/w/mine/pulse', true);

    await screen.findAllByRole('article');
    await user.keyboard('j');
    await user.keyboard('j');
    await user.keyboard('{Shift>}{F10}{/Shift}');

    const menu = await screen.findByRole('menu', { name: 'Growth actions' });
    await within(menu).findByRole('menuitem', { name: 'Unfollow initiative' });
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(
      within(menu).getByRole('menuitem', { name: 'Unfollow initiative' })
    ).toHaveFocus();
    expect(
      screen.getByRole('article', {
        name: 'Growth: Adam Admin posted an update',
      })
    ).toHaveAttribute('aria-current', 'true');

    await user.keyboard('{Enter}');

    expect(setFollow).toHaveBeenCalledWith('ws-1', 'initiative', 'i-1', false);
    expect(screen.queryByText('Project page')).not.toBeInTheDocument();
  });
});
