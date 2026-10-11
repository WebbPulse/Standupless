/**
 * The recurring issue contract the frontend depends on: the team path, the
 * verbs, and a list answer that always carries its array and a timezone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRecurringIssue,
  deleteRecurringIssue,
  listRecurringIssues,
  updateRecurringIssue,
} from './recurring';

const get = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();
const post =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const patch =
  vi.fn<
    (path: string, body?: unknown, options?: unknown) => Promise<unknown>
  >();
const del = vi.fn<(path: string, options?: unknown) => Promise<unknown>>();

vi.mock('./client', () => ({
  default: {
    get: (path: string, options?: unknown) => get(path, options),
    post: (path: string, body?: unknown, options?: unknown) =>
      post(path, body, options),
    patch: (path: string, body?: unknown, options?: unknown) =>
      patch(path, body, options),
    delete: (path: string, options?: unknown) => del(path, options),
  },
}));

const PATH = '/workspaces/ws-1/teams/team-1/recurring-issues';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('recurring issues', () => {
  it('lists a team schedule with its default timezone', async () => {
    get.mockResolvedValue({
      data: {
        recurring_issues: [{ id: 'rc-1' }],
        default_timezone: 'Europe/Paris',
      },
    });
    const answer = await listRecurringIssues('ws-1', 'team-1');
    expect(get).toHaveBeenCalledWith(PATH, undefined);
    expect(answer.recurring_issues).toHaveLength(1);
    expect(answer.default_timezone).toBe('Europe/Paris');
  });

  it('answers an empty list and UTC when the body is missing them', async () => {
    get.mockResolvedValue({ data: {} });
    expect(await listRecurringIssues('ws-1', 'team-1')).toEqual({
      recurring_issues: [],
      default_timezone: 'UTC',
    });
  });

  it('creates, patches and deletes under the team', async () => {
    post.mockResolvedValue({ data: {} });
    patch.mockResolvedValue({ data: {} });
    del.mockResolvedValue({ data: undefined });
    await createRecurringIssue('ws-1', 'team-1', {
      template_id: 'tp-1',
      frequency: 'daily',
    });
    await updateRecurringIssue('ws-1', 'team-1', 'rc-1', { paused: true });
    await deleteRecurringIssue('ws-1', 'team-1', 'rc-1');
    expect(post).toHaveBeenCalledWith(
      PATH,
      { template_id: 'tp-1', frequency: 'daily' },
      undefined
    );
    expect(patch).toHaveBeenCalledWith(
      `${PATH}/rc-1`,
      { paused: true },
      undefined
    );
    expect(del).toHaveBeenCalledWith(`${PATH}/rc-1`, undefined);
  });
});
