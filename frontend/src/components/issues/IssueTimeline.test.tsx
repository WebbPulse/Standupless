/**
 * The issue timeline's activity filter. Covers that all activity shows changes,
 * collapsed runs and comments together, that comments only hides every change
 * and keeps the comments, that the choice saves to the account and is restored
 * from it, that comments only still reads older comment pages, and the empty
 * state when an issue has no comments.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '../../contexts/AuthContextDefinition';
import type {
  ActivityFilter,
  ActivityListRead,
  ActivityRead,
  CommentListRead,
  CommentRead,
  UserPreferencesUpdate,
  UserRead,
} from '../../types/Api';
import type { ActivityContext } from '../../lib/activityDisplay';
import IssueTimeline from './IssueTimeline';

const listActivity =
  vi.fn<(cursor: string | undefined) => Promise<ActivityListRead>>();
const listComments =
  vi.fn<(cursor: string | undefined) => Promise<CommentListRead>>();
const updatePreferences =
  vi.fn<(body: UserPreferencesUpdate) => Promise<UserRead>>();
const login = vi.fn<(user: UserRead) => void>();

vi.mock('../../api/issues', async () => {
  const actual =
    await vi.importActual<typeof import('../../api/issues')>(
      '../../api/issues'
    );
  return {
    ...actual,
    listActivity: (
      _w: string,
      _i: string,
      params: { cursor?: string } | undefined
    ) => listActivity(params?.cursor),
  };
});

vi.mock('../../api/discussion', async () => {
  const actual = await vi.importActual<typeof import('../../api/discussion')>(
    '../../api/discussion'
  );
  return {
    ...actual,
    listComments: (
      _w: string,
      _i: string,
      params: { cursor?: string } | undefined
    ) => listComments(params?.cursor),
    listAttachments: () =>
      Promise.resolve({ attachments: [], next_cursor: null }),
    listReactions: () => Promise.resolve([]),
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

vi.mock('../../api/notifications', () => ({
  updatePreferences: (body: UserPreferencesUpdate) => updatePreferences(body),
}));

vi.mock('../../api/integrations', () => ({
  listThreadTargets: () => Promise.resolve([]),
  syncThread: () => Promise.resolve({}),
  unsyncThread: () => Promise.resolve(),
}));

vi.mock('../../api/drafts', () => ({
  listIssueDrafts: () => Promise.resolve([]),
  saveDraft: () => Promise.resolve({}),
  deleteDraft: () => Promise.resolve(),
}));

/** The signed in person, with the filter they saved. */
const person = (filter: ActivityFilter = 'all'): UserRead => ({
  id: 'user-1',
  email: 'someone@example.com',
  display_name: 'Someone',
  email_verified: true,
  activity_filter: filter,
});

let signedIn: UserRead = person();

vi.mock('../../hooks/useAuth', () => ({
  useAuth: (): Partial<AuthContextType> => ({
    isAuthenticated: true,
    user: signedIn,
    login,
  }),
}));

const context: ActivityContext = {
  statuses: [],
  people: [],
  labels: [],
  issues: [],
  projects: [],
  cycles: [],
};

/** One recorded change on the issue. */
const change = (
  id: string,
  at: string,
  overrides: Partial<ActivityRead> = {}
): ActivityRead => ({
  activity_id: id,
  issue_id: 'iss-1',
  kind: 'created',
  field: null,
  from: null,
  to: null,
  actor_kind: 'github',
  actor_id: 'gh-1',
  created_at: at,
  ...overrides,
});

/** A root comment on the issue. */
const comment = (id: string, body: string, at: string): CommentRead => ({
  comment_id: id,
  issue_id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 't-1',
  body,
  parent_comment_id: null,
  author_id: 'user-2',
  author: { user_id: 'user-2', display_name: 'Ada', email: 'ada@example.com' },
  mentions: [],
  reactions: [],
  reply_count: 0,
  created_at: at,
  edited_at: null,
});

const renderTimeline = () =>
  render(
    <MemoryRouter>
      <IssueTimeline
        workspaceId="ws-1"
        issueId="iss-1"
        currentUserId="user-1"
        canComment={false}
        isAdmin={false}
        context={context}
        slug="mine"
        teamKeyPrefix="ENG"
      />
    </MemoryRouter>
  );

beforeEach(() => {
  signedIn = person();
  listActivity.mockReset();
  listComments.mockReset();
  updatePreferences.mockReset();
  login.mockReset();
  listActivity.mockResolvedValue({
    activity: [
      change('ac-1', '2026-09-17T01:00:00Z'),
      change('ac-2', '2026-09-17T03:00:00Z', {
        kind: 'link_added',
        actor_kind: 'user',
        actor_id: 'user-2',
      }),
      change('ac-3', '2026-09-17T03:01:00Z', {
        kind: 'link_added',
        actor_kind: 'user',
        actor_id: 'user-2',
      }),
    ],
    next_cursor: null,
  });
  listComments.mockResolvedValue({
    comments: [comment('c-1', 'Looks good to me', '2026-09-17T02:00:00Z')],
    next_cursor: null,
  });
  updatePreferences.mockImplementation((body) =>
    Promise.resolve({
      ...signedIn,
      activity_filter: body.activity_filter ?? 'all',
    })
  );
});

describe('the activity filter', () => {
  it('shows changes and comments together under all activity', async () => {
    renderTimeline();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(/GitHub\s*created the issue/);
    });
    expect(timeline).toHaveTextContent('Looks good to me');
    expect(
      within(timeline).getByRole('button', { name: 'Show' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Filter activity: All activity' })
    ).toBeInTheDocument();
  });

  it('hides every change and collapsed run under comments only, and saves the choice', async () => {
    const user = userEvent.setup();
    renderTimeline();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(/GitHub\s*created the issue/);
    });

    await user.click(
      screen.getByRole('button', { name: 'Filter activity: All activity' })
    );
    await user.click(screen.getByRole('menuitem', { name: 'Comments only' }));

    const filtered = screen.getByRole('list', { name: 'Timeline' });
    expect(filtered).not.toHaveTextContent('created the issue');
    expect(within(filtered).queryByRole('button', { name: 'Show' })).toBe(null);
    expect(filtered).toHaveTextContent('Looks good to me');
    expect(
      screen.getByRole('button', { name: 'Filter activity: Comments only' })
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalledWith({
        activity_filter: 'comments',
      });
    });
    await waitFor(() => {
      expect(login).toHaveBeenCalledWith(
        expect.objectContaining({ activity_filter: 'comments' })
      );
    });
  });

  it('opens on comments only when the account saved it', async () => {
    signedIn = person('comments');
    renderTimeline();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent('Looks good to me');
    });
    expect(timeline).not.toHaveTextContent('created the issue');
    expect(updatePreferences).not.toHaveBeenCalled();
  });

  it('goes back to all activity and saves that too', async () => {
    signedIn = person('comments');
    const user = userEvent.setup();
    renderTimeline();

    await user.click(
      await screen.findByRole('button', {
        name: 'Filter activity: Comments only',
      })
    );
    await user.click(screen.getByRole('menuitem', { name: 'All activity' }));

    const timeline = screen.getByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent(/GitHub\s*created the issue/);
    });
    expect(updatePreferences).toHaveBeenCalledWith({ activity_filter: 'all' });
  });

  it('still reads older comment pages under comments only', async () => {
    signedIn = person('comments');
    listComments.mockImplementation((cursor) =>
      Promise.resolve(
        cursor === undefined
          ? {
              comments: [
                comment('c-2', 'The newest word', '2026-09-17T05:00:00Z'),
              ],
              next_cursor: 'cur-2',
            }
          : {
              comments: [
                comment('c-1', 'The oldest word', '2026-09-17T00:10:00Z'),
              ],
              next_cursor: null,
            }
      )
    );
    renderTimeline();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    await waitFor(() => {
      expect(timeline).toHaveTextContent('The oldest word');
    });
    expect(timeline).toHaveTextContent('The newest word');
    expect(listComments).toHaveBeenCalledWith('cur-2');
    expect(
      (timeline.textContent ?? '').indexOf('The oldest word')
    ).toBeLessThan((timeline.textContent ?? '').indexOf('The newest word'));
    expect(screen.queryByRole('button', { name: 'Show older activity' })).toBe(
      null
    );
  });

  it('says there are no comments yet when comments only finds none', async () => {
    signedIn = person('comments');
    listComments.mockResolvedValue({ comments: [], next_cursor: null });
    renderTimeline();

    expect(await screen.findByText('No comments yet')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Timeline' })).toBe(null);
  });
});

describe('long stretches of history', () => {
  it('folds the middle behind a row that shows it on request', async () => {
    const user = userEvent.setup();
    listActivity.mockResolvedValue({
      activity: Array.from({ length: 8 }, (_, place) =>
        change(`ac-${String(place)}`, `2026-09-17T0${String(place)}:00:00Z`, {
          kind: 'archived',
        })
      ),
      next_cursor: null,
    });
    listComments.mockResolvedValue({ comments: [], next_cursor: null });
    renderTimeline();

    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    const more = await within(timeline).findByRole('button', {
      name: 'Show 4 more events',
    });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(5);

    await user.click(more);

    expect(
      within(timeline).queryByRole('button', { name: /more events/ })
    ).toBe(null);
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(8);
  });
});
