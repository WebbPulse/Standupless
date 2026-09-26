import { describe, expect, it } from 'vitest';
import type { ActivityRead } from '../types/Api';
import {
  commitReference,
  describeActivity,
  groupSentence,
  shortSha,
  type ActivityContext,
} from './activityDisplay';

const context: ActivityContext = {
  statuses: [
    { id: 'st-todo', name: 'Todo', category: 'unstarted' },
    { id: 'st-doing', name: 'In Progress', category: 'started' },
  ],
  people: [
    { user_id: 'u-1', email: 'tyler@example.com', display_name: 'Tyler' },
    { user_id: 'u-2', email: 'sam@example.com', display_name: null },
  ],
  labels: [
    { id: 'l-bug', name: 'bug' },
    { id: 'l-ui', name: 'ui' },
  ],
  issues: [{ id: 'i-9', key: 'ENG-9' }],
  projects: [
    { id: 'p-1', name: 'Q4 Launch' },
    { id: 'p-2', name: 'Billing' },
  ],
  cycles: [{ id: 'c-3', name: 'Cycle 3' }],
};

const entry = (overrides: Partial<ActivityRead>): ActivityRead => ({
  activity_id: 'a-1',
  issue_id: 'i-1',
  actor_id: 'u-1',
  actor_kind: 'user',
  kind: 'field_changed',
  field: null,
  from: null,
  to: null,
  created_at: '2026-09-20T10:00:00Z',
  ...overrides,
});

const text = (overrides: Partial<ActivityRead>): string =>
  describeActivity(entry(overrides), context).text;

describe('describeActivity', () => {
  it('reads a creation', () => {
    expect(text({ kind: 'created' })).toBe('created the issue');
  });

  it('names both statuses of a move', () => {
    expect(text({ field: 'status_id', from: 'st-todo', to: 'st-doing' })).toBe(
      'changed the status from Todo to In Progress'
    );
    expect(text({ field: 'status_id', from: null, to: 'st-todo' })).toBe(
      'set the status to Todo'
    );
  });

  it('reads assignment, self-assignment and removal', () => {
    expect(text({ field: 'assignee_id', to: 'u-2' })).toBe(
      'assigned the issue to sam@example.com'
    );
    expect(text({ field: 'assignee_id', to: 'u-1' })).toBe(
      'self-assigned the issue'
    );
    expect(text({ field: 'assignee_id', from: 'u-2', to: null })).toBe(
      'unassigned sam@example.com'
    );
  });

  it('reads priority by its label', () => {
    expect(text({ field: 'priority', from: 'none', to: 'high' })).toBe(
      'set the priority to High'
    );
    expect(text({ field: 'priority', from: 'low', to: 'none' })).toBe(
      'removed the priority'
    );
  });

  it('names the labels added and removed', () => {
    expect(
      text({ field: 'label_ids', from: ['l-bug'], to: ['l-bug', 'l-ui'] })
    ).toBe('added label ui');
    expect(text({ field: 'label_ids', from: ['l-bug', 'l-ui'], to: [] })).toBe(
      'removed labels bug and ui'
    );
  });

  it('names the parent by key', () => {
    expect(text({ field: 'parent_id', to: 'i-9' })).toBe(
      'made this a sub-issue of ENG-9'
    );
  });

  it('carries the commit a push linked, grouped for collapsing', () => {
    const described = describeActivity(
      entry({
        actor_kind: 'github',
        field: 'github_commit',
        to: {
          repository: 'acme/app',
          sha: 'abcdef1234567',
          url: 'https://github.com/acme/app/commit/abcdef1',
          message: 'Fix it',
        },
      }),
      context
    );
    expect(described.text).toBe('linked commit');
    expect(described.group).toBe('commit');
    expect(described.commit?.sha).toBe('abcdef1234567');
  });

  it('still reads the older commit rows that held only a repository', () => {
    const described = describeActivity(
      entry({ field: 'github_commit', to: 'acme/app' }),
      context
    );
    expect(described.text).toBe('mentioned this issue in a commit to acme/app');
    expect(described.group).toBeNull();
  });

  it('reads a relation with the target key', () => {
    expect(text({ kind: 'link_added', field: 'blocks', to: 'i-9' })).toBe(
      'marked this as blocking ENG-9'
    );
  });

  it('carries each status as a part the view draws with its glyph', () => {
    const { parts } = describeActivity(
      entry({ field: 'status_id', from: 'st-todo', to: 'st-doing' }),
      context
    );
    expect(parts.filter((part) => part.type === 'status')).toEqual([
      { type: 'status', id: 'st-todo', name: 'Todo', category: 'unstarted' },
      {
        type: 'status',
        id: 'st-doing',
        name: 'In Progress',
        category: 'started',
      },
    ]);
  });

  it('names the project and cycle an issue moved to, as linkable parts', () => {
    expect(text({ field: 'project_id', from: null, to: 'p-1' })).toBe(
      'added the issue to project Q4 Launch'
    );
    expect(text({ field: 'project_id', from: 'p-1', to: 'p-2' })).toBe(
      'moved the issue to project Billing'
    );
    expect(text({ field: 'project_id', from: 'p-2', to: null })).toBe(
      'removed the issue from project Billing'
    );
    const { parts } = describeActivity(
      entry({ field: 'cycle_id', from: null, to: 'c-3' }),
      context
    );
    expect(parts).toContainEqual({
      type: 'entity',
      kind: 'cycle',
      id: 'c-3',
      name: 'Cycle 3',
    });
  });

  it('reads a deleted project or cycle without naming it', () => {
    expect(text({ field: 'project_id', from: null, to: 'p-gone' })).toBe(
      'added the issue to a project'
    );
    expect(text({ field: 'cycle_id', from: 'c-gone', to: null })).toBe(
      'removed the issue from its cycle'
    );
  });

  it('links the person an issue was assigned to', () => {
    const { parts } = describeActivity(
      entry({ field: 'assignee_id', to: 'u-2' }),
      context
    );
    expect(parts).toContainEqual({
      type: 'entity',
      kind: 'person',
      id: 'u-2',
      name: 'sam@example.com',
    });
  });

  it('reads a relation to an issue the page does not know', () => {
    expect(text({ kind: 'link_added', field: 'blocked_by', to: 'i-x' })).toBe(
      'marked this as blocked by another issue'
    );
  });

  it('names the target of a removed relation by key and title', () => {
    const removed = describeActivity(
      entry({
        kind: 'link_removed',
        field: 'blocks',
        from: { id: 'i-12', key: 'ABC-12', title: 'Title' },
      }),
      context
    );
    expect(removed.text).toBe('removed blocking ABC-12 Title');
    expect(removed.parts).toContainEqual({
      type: 'entity',
      kind: 'issue',
      id: 'i-12',
      name: 'ABC-12',
    });
    expect(
      text({
        kind: 'link_removed',
        field: 'duplicate_of',
        from: { id: 'i-9', key: 'ENG-9', title: 'Crash' },
      })
    ).toBe('removed duplicate of ENG-9 Crash');
  });

  it('still reads an older removed relation that held only the link id', () => {
    expect(text({ kind: 'link_removed', from: 'link-1' })).toBe(
      'removed a relation'
    );
  });

  it('reads a relation added with the whole target', () => {
    expect(
      text({
        kind: 'link_added',
        field: 'relates_to',
        to: { id: 'i-4', key: 'ABC-4', title: 'Other' },
      })
    ).toBe('marked this as related to ABC-4 Other');
  });

  it('names a sub-issue added or removed, old and new forms', () => {
    expect(
      text({
        kind: 'child_added',
        to: { id: 'i-3', key: 'ABC-3', title: 'Child' },
      })
    ).toBe('added sub-issue ABC-3 Child');
    expect(
      text({
        kind: 'child_removed',
        from: { id: 'i-3', key: 'ABC-3', title: 'Child' },
      })
    ).toBe('removed sub-issue ABC-3 Child');
    expect(text({ kind: 'child_added', to: 'i-9' })).toBe(
      'added sub-issue ENG-9'
    );
    expect(text({ kind: 'child_removed', from: 'i-gone' })).toBe(
      'removed sub-issue an issue'
    );
  });

  it('falls back to plain words for a field it does not know', () => {
    expect(text({ field: 'story_points' })).toBe('changed the story points');
  });
});

describe('commit helpers', () => {
  it('shortens a sha to seven characters', () => {
    expect(shortSha('abcdef1234567')).toBe('abcdef1');
  });

  it('refuses a value with no sha', () => {
    expect(commitReference({ repository: 'x' })).toBeNull();
    expect(commitReference('acme/app')).toBeNull();
  });

  it('counts a collapsed run', () => {
    expect(groupSentence('commit', 3)).toBe('linked 3 commits');
  });
});
