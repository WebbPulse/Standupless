/**
 * A cold load of a workspace home with six teams, driven through the real app,
 * the real API client and a stubbed `fetch`, counting the GETs that reach the
 * wire. Production rate limits every caller at a fixed number of reads a
 * minute, so a page that fans the same read out per component spends that
 * allowance on duplicates and answers the person with 429s.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from './contexts/AuthContextDefinition';

const WORKSPACE_ID = 'ws-1';
const TEAM_COUNT = 6;
const USER_ID = 'user-1';

const teams = Array.from({ length: TEAM_COUNT }, (_, index) => ({
  id: `team-${index + 1}`,
  workspace_id: WORKSPACE_ID,
  name: `Team ${index + 1}`,
  key_prefix: `T${index + 1}`,
  description: null,
  estimate_scale: 'none',
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
  role: 'admin',
  member_count: 1,
  is_member: true,
}));

const issue = (team: (typeof teams)[number], number: number) => ({
  id: `${team.id}-issue-${number}`,
  workspace_id: WORKSPACE_ID,
  team_id: team.id,
  key: `${team.key_prefix}-${number}`,
  number,
  title: `Issue ${number} of ${team.name}`,
  body: null,
  status_id: `${team.id}-todo`,
  priority: 'none',
  assignee_id: team.id === 'team-1' && number === 2 ? USER_ID : null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: USER_ID,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
});

const issues = [1, 2, 3].flatMap((n) => teams.map((team) => issue(team, n)));

/** Answers one API path with a body shaped like the backend's. */
const answer = (url: URL): unknown => {
  const path = url.pathname;
  if (path.endsWith('/workspaces') || path.endsWith('/workspaces/')) {
    return {
      workspaces: [
        {
          id: WORKSPACE_ID,
          name: 'Acme',
          slug: 'acme',
          plan: 'free',
          created_at: '2026-09-01T00:00:00Z',
          role: 'owner',
        },
      ],
    };
  }
  const teamMatch = /\/teams\/([^/]+)\/(statuses|labels|members)\/?$/.exec(
    path
  );
  if (teamMatch !== null) {
    const [, teamId, list] = teamMatch;
    if (list === 'statuses') {
      return {
        statuses: [
          {
            id: `${teamId}-todo`,
            name: 'Todo',
            category: 'unstarted',
            position: 0,
          },
        ],
      };
    }
    if (list === 'labels') return { labels: [] };
    return {
      members: [
        {
          user_id: USER_ID,
          email: 'maya@example.com',
          display_name: 'Maya Chen',
          role: 'admin',
          added_at: '2026-09-01T00:00:00Z',
        },
      ],
    };
  }
  if (/\/teams\/?$/.test(path)) return { teams };
  if (/\/views\/home\/?$/.test(path)) {
    const mine = teams.map((team) => issue(team, 1));
    return {
      generated_at: '2026-09-17T12:00:00Z',
      today: '2026-09-17',
      team_ids: teams.map((team) => team.id),
      focus: {
        open_count: mine.length,
        truncated: false,
        attention_count: 0,
        in_progress_count: 0,
        up_next_count: mine.length,
        attention: [],
        in_progress: [],
        up_next: mine,
      },
      cycles: [],
      projects: [],
      projects_total: 0,
      shipped: {
        since: '2026-09-10T12:00:00Z',
        count: 0,
        mine: 0,
        items: [],
      },
      pulse: [],
      inbox: { unread_count: 0, items: [] },
      pull_requests: [],
      releases: [],
    };
  }
  if (/\/issues\/?$/.test(path)) {
    const assignee = url.searchParams.get('assignee_id');
    const rows =
      assignee === null
        ? issues
        : issues.filter((row) => row.assignee_id !== null);
    return { issues: rows, next_cursor: null };
  }
  if (/\/cycles\/?$/.test(path)) return { cycles: [], next_cursor: null };
  if (/\/projects\/?$/.test(path)) return { projects: [], next_cursor: null };
  if (/\/roadmap\/?$/.test(path)) return { entries: [], next_cursor: null };
  if (/\/members\/?$/.test(path)) return { members: [] };
  if (/\/views\/?$/.test(path)) return { views: [] };
  if (/count\/?$/.test(path)) return { unread: 0, count: 0 };
  if (/\/inbox\/?$/.test(path)) return { notifications: [], next_cursor: null };
  return {};
};

const gets: string[] = [];

vi.mock('@webbpulse/auth/react', async () => {
  const actual = await vi.importActual<typeof import('@webbpulse/auth/react')>(
    '@webbpulse/auth/react'
  );
  return {
    ...actual,
    useQueryAuth: () => ({ waitForToken: () => Promise.resolve(null) }),
    useDismissedUntilSignIn: () => ({ dismissed: true, dismiss: vi.fn() }),
  };
});

vi.mock('./hooks/useAuth', () => ({
  useAuth: (): AuthContextType => ({
    isAuthenticated: true,
    isLoading: false,
    isBusy: false,
    user: {
      id: USER_ID,
      email: 'maya@example.com',
      display_name: 'Maya Chen',
      email_verified: true,
    },
    login: vi.fn(),
    logout: vi.fn(() => Promise.resolve()),
    checkAuthStatus: vi.fn(() => Promise.resolve()),
  }),
}));

beforeEach(() => {
  gets.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        'http://localhost'
      );
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        gets.push(`${url.pathname}${url.search}`);
      }
      const delayMs = url.searchParams.has('assignee_id')
        ? 0
        : url.pathname.endsWith('/issues')
          ? 60
          : 5;
      return new Promise<Response>((resolve) => {
        setTimeout(() => {
          resolve(
            new Response(JSON.stringify(answer(url)), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          );
        }, delayMs);
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Counts each distinct GET, for the assertion message. */
const tally = (): Record<string, number> =>
  gets.reduce<Record<string, number>>((counts, url) => {
    counts[url] = (counts[url] ?? 0) + 1;
    return counts;
  }, {});

describe('cold workspace load', () => {
  it('reads each list once and stays well under the GET allowance', async () => {
    const { default: App } = await import('./App');
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/w/acme']}>
          <App />
        </MemoryRouter>
      </StrictMode>
    );

    await screen.findAllByText(/Issue 1 of Team 6/);
    await waitFor(() => {
      expect(
        gets.filter((url) => url.includes('/teams/team-6/members'))
      ).not.toHaveLength(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const counts = tally();
    expect(gets.length, JSON.stringify(counts, null, 2)).toBeLessThan(60);
    const repeated = Object.entries(counts).filter(([, n]) => n > 1);
    expect(repeated, JSON.stringify(counts, null, 2)).toEqual([]);
    expect(gets.filter((url) => /\/views\/home(\?|$)/.test(url))).toHaveLength(
      1
    );
    expect(
      gets.filter((url) => /\/projects(\?|$)/.test(url)).length
    ).toBeLessThanOrEqual(1);
    for (const team of teams) {
      expect(
        gets.filter((url) => url.includes(`/teams/${team.id}/statuses`))
      ).toHaveLength(1);
    }
  });
});
