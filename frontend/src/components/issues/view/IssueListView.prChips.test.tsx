/**
 * The pull request chip on a row or card: the lead pull request's glyph
 * colored by its state and review, its number or a count, a hover list of
 * every pull request, a link that opens the lead one, and the display toggle
 * that hides it.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueCollection } from '../../../hooks/useIssueCollection';
import type { IssueContextState } from '../../../hooks/useIssueContext';
import {
  createShortcutRegistry,
  ShortcutRegistryContext,
  type ShortcutRegistry,
} from '../../../hooks/useShortcuts';
import {
  defaultViewState,
  DEFAULT_VISIBLE,
  type IssueContext,
  type ViewState,
} from '../../../lib/issueView';
import { pullRequestChipStyle } from '../../../lib/pullRequestState';
import type { PullRequestSummaryEntryRead } from '../../../types/Api';
import IssueListView from './IssueListView';

/** One linked pull request with the given overrides. */
const entry = (
  overrides: Partial<PullRequestSummaryEntryRead> = {}
): PullRequestSummaryEntryRead => ({
  repository_full_name: 'acme/api',
  number: 42,
  title: 'Cache the token',
  url: 'https://github.com/acme/api/pull/42',
  state: 'open',
  review_state: 'none',
  ci_state: 'none',
  ...overrides,
});

/** The issue under test, linking the given pull requests. */
const issueWith = (
  pullRequests: PullRequestSummaryEntryRead[] | null,
  count = pullRequests?.length ?? 0
): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-1',
  priority: 'high',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  pull_request_summary:
    pullRequests === null ? null : { count, pull_requests: pullRequests },
  created_by: 'user-1',
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
});

const context: IssueContext = {
  statuses: [
    {
      id: 'st-1',
      name: 'Todo',
      category: 'unstarted',
      position: 0,
      team_id: 'team-1',
    },
  ],
  labels: [],
  people: [
    { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
  ],
  projects: [],
  cycles: [],
  currentUserId: 'user-1',
};

const lists: IssueContextState = {
  context,
  forTeam: () => context,
  isLoading: false,
  createLabel: () => Promise.resolve(null),
};

let registry: ShortcutRegistry;

interface Options {
  layout?: 'list' | 'board';
  hidden?: boolean;
}

/** Mounts the view over one issue. */
const renderView = (
  issue: OrderedIssueRead,
  { layout = 'list', hidden = false }: Options = {}
) => {
  const collection: IssueCollection = {
    issues: [issue],
    isLoading: false,
    error: null,
    truncated: false,
    queryKey: ['issues'],
    update: vi.fn<IssueCollection['update']>(),
  };
  const base = defaultViewState(layout);
  const state: ViewState = {
    ...base,
    visible: hidden
      ? base.visible.filter((property) => property !== 'pull_requests')
      : base.visible,
  };
  render(
    <MemoryRouter initialEntries={['/w/mine/team/ENG/issues']}>
      <ShortcutRegistryContext.Provider value={registry}>
        <IssueListView
          slug="mine"
          state={state}
          onStateChange={vi.fn<(next: ViewState) => void>()}
          collection={collection}
          lists={lists}
          scaleFor={() => 'tshirt'}
          canEdit
        />
      </ShortcutRegistryContext.Provider>
    </MemoryRouter>
  );
};

beforeEach(() => {
  registry = createShortcutRegistry();
});

describe('pullRequestChipStyle', () => {
  it.each([
    ['draft', 'none', 'Draft', 'text-text-faint'],
    ['open', 'none', 'Open', 'text-success'],
    ['open', 'pending', 'Review requested', 'text-warning'],
    ['open', 'approved', 'Approved', 'text-accent'],
    ['merged', 'approved', 'Merged', 'text-merged'],
    ['closed', 'pending', 'Closed', 'text-danger'],
  ])('reads %s with review %s as %s', (state, review, label, color) => {
    const style = pullRequestChipStyle({ state, review_state: review });
    expect(style.label).toBe(label);
    expect(style.colorClass).toBe(color);
  });
});

describe.each(['list', 'board'] as const)('the chip on the %s', (layout) => {
  it('shows the number of a single pull request and opens it', () => {
    renderView(issueWith([entry({ review_state: 'approved' })]), { layout });

    const chip = screen.getByRole('link', {
      name: 'Pull request #42, Approved',
    });
    expect(chip).toHaveTextContent('#42');
    expect(chip).toHaveAttribute('href', 'https://github.com/acme/api/pull/42');
    expect(chip).toHaveAttribute('target', '_blank');
    expect(screen.getByTestId('pull-request-chip-glyph')).toHaveClass(
      'text-accent'
    );
  });

  it('shows a count for several and lists each on hover', () => {
    renderView(
      issueWith(
        [
          entry({ number: 7, state: 'merged', title: 'Ship it' }),
          entry({ number: 9, title: 'Follow up' }),
        ],
        3
      ),
      { layout }
    );

    const chip = screen.getByRole('link', {
      name: '3 pull requests, Merged',
    });
    expect(chip).toHaveTextContent('3 PRs');
    expect(chip).toHaveAttribute('href', 'https://github.com/acme/api/pull/42');
    expect(chip.nextElementSibling?.textContent).toBe(
      'acme/api#7 Ship it (Merged)\nacme/api#9 Follow up (Open)\nand 1 more'
    );
  });

  it('draws nothing for an issue with no pull requests', () => {
    renderView(issueWith(null), { layout });

    expect(screen.queryByTestId('pull-request-chip-glyph')).toBeNull();
  });

  it('hides the chip when the view hides pull requests', () => {
    renderView(issueWith([entry()]), { layout, hidden: true });

    expect(screen.queryByTestId('pull-request-chip-glyph')).toBeNull();
  });
});

describe('the display option', () => {
  it('shows pull requests by default', () => {
    expect(DEFAULT_VISIBLE).toContain('pull_requests');
  });
});
