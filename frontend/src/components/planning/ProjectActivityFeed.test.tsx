/**
 * The project activity feed. Covers that changes and updates interleave newest
 * first, that an update older than the loaded activity waits for its page, that
 * "Show more" reveals rows and reads the next page, and the empty and error states.
 */

import type { ComponentProps } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectActivity } from '../../hooks/useProjectActivity';
import type { ProjectActivityRead, ProjectUpdateRead } from '../../types/Api';
import ProjectActivityFeed from './ProjectActivityFeed';

const feed = vi.fn<() => ProjectActivity>();

vi.mock('../../hooks/useProjectActivity', () => ({
  useProjectActivity: () => feed(),
}));

const people = [
  {
    user_id: 'user-1',
    email: 'ada@example.com',
    display_name: 'Ada',
    avatar_url: null,
    full_name: '',
  },
];

const change = (
  id: string,
  at: string,
  overrides: Partial<ProjectActivityRead> = {}
): ProjectActivityRead => ({
  activity_id: id,
  project_id: 'prj-1',
  actor_id: 'user-1',
  kind: 'field_changed',
  field: 'priority',
  from: 'none',
  to: 'high',
  milestone_id: null,
  created_at: at,
  ...overrides,
});

const update = (id: string, at: string): ProjectUpdateRead => ({
  update_id: id,
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  body: 'Going well',
  health: 'on_track',
  author_id: 'user-1',
  created_at: at,
  updated_at: at,
  edited_at: null,
  can_edit: true,
});

const loaded = (
  activity: ProjectActivityRead[],
  overrides: Partial<ProjectActivity> = {}
): ProjectActivity => ({
  activity,
  isLoading: false,
  error: null,
  isPaging: false,
  hasMore: false,
  loadMore: vi.fn(),
  ...overrides,
});

const renderFeed = (
  updates: ProjectUpdateRead[] = [],
  props: Partial<ComponentProps<typeof ProjectActivityFeed>> = {}
) =>
  render(
    <ProjectActivityFeed
      workspaceId="ws-1"
      projectId="prj-1"
      people={people}
      teams={[]}
      initiatives={[]}
      milestones={[]}
      updates={updates}
      updatesHaveMore={false}
      onLoadMoreUpdates={vi.fn()}
      onOpenUpdates={vi.fn()}
      {...props}
    />
  );

const rows = (): HTMLElement[] =>
  within(
    screen
      .getByRole('heading', { name: 'Activity' })
      .closest('section') as HTMLElement
  ).queryAllByRole('listitem');

describe('ProjectActivityFeed', () => {
  beforeEach(() => {
    feed.mockReset();
  });

  it('interleaves changes and updates newest first', () => {
    feed.mockReturnValue(
      loaded([
        change('act-2', '2026-10-03T00:00:00Z'),
        change('act-1', '2026-10-01T00:00:00Z', {
          kind: 'created',
          field: null,
          from: null,
          to: null,
        }),
      ])
    );
    renderFeed([update('upd-1', '2026-10-02T00:00:00Z')]);

    const shown = rows();
    expect(shown).toHaveLength(3);
    expect(shown[0]).toHaveTextContent('Ada set the priority to High');
    expect(shown[1]).toHaveTextContent('Ada posted an update On track');
    expect(shown[2]).toHaveTextContent('Ada created the project');
  });

  it('holds back an update older than the activity loaded so far', () => {
    feed.mockReturnValue(
      loaded([change('act-2', '2026-10-03T00:00:00Z')], { hasMore: true })
    );
    renderFeed([update('upd-1', '2026-10-01T00:00:00Z')]);

    expect(rows()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Show more' })).toBeVisible();
  });

  it('reveals more rows and reads the next page', async () => {
    const user = userEvent.setup();
    const loadMore = vi.fn();
    const activity = Array.from({ length: 12 }, (_, place) =>
      change(
        `act-${String(place)}`,
        `2026-10-${String(20 - place).padStart(2, '0')}T00:00:00Z`
      )
    );
    feed.mockReturnValue(loaded(activity, { hasMore: true, loadMore }));
    renderFeed();

    expect(rows()).toHaveLength(10);
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(rows()).toHaveLength(12);
    expect(loadMore).toHaveBeenCalled();
  });

  it('opens the updates tab from an update row', async () => {
    const user = userEvent.setup();
    const onOpenUpdates = vi.fn();
    feed.mockReturnValue(loaded([]));
    renderFeed([update('upd-1', '2026-10-02T00:00:00Z')], { onOpenUpdates });

    await user.click(screen.getByRole('button', { name: 'posted an update' }));
    expect(onOpenUpdates).toHaveBeenCalled();
  });

  it('says when nothing has happened and when the read failed', () => {
    feed.mockReturnValue(loaded([], { error: new Error('down') }));
    renderFeed();

    expect(screen.getByText('No activity yet.')).toBeVisible();
    expect(screen.getByRole('alert')).toBeVisible();
  });
});
