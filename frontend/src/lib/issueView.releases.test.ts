/**
 * Grouping by release: an issue sits under every release that carries it and
 * under No release when none does, groups read by pipeline stage then the
 * newest first, the grouping is offered only once releases are read, a board
 * refuses drags between release columns, and the release filter rides the
 * list query.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import { releasesByIssue } from '../hooks/useReleaseIndex';
import type { ReleaseIndexEntryRead } from '../types/Api';
import {
  defaultViewState,
  fieldsFor,
  filterFieldsFor,
  GROUP_FIELDS,
  groupIssues,
  isMovableGroupField,
  moveChange,
  parseViewState,
  releasesInOrder,
  releasesOf,
  sameViewState,
  viewStateQuery,
  writeViewState,
  type IssueContext,
  type ViewState,
} from './issueView';

/** An issue with the given fields over a plain default. */
const issue = (fields: Partial<OrderedIssueRead> = {}): OrderedIssueRead => ({
  id: 'iss-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  key: 'ENG-1',
  number: 1,
  title: 'Cache the token',
  body: null,
  status_id: 'st-todo',
  priority: 'medium',
  assignee_id: null,
  label_ids: [],
  estimate: null,
  start_date: null,
  due_date: null,
  parent_id: null,
  cycle_id: null,
  project_id: null,
  progress: { total: 0, completed: 0 },
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...fields,
});

const context: IssueContext = {
  statuses: [],
  labels: [],
  people: [],
  projects: [],
  cycles: [],
  releases: [
    {
      id: 'rel-prod-old',
      name: 'v1.0',
      teamId: 'team-1',
      stagePosition: 1,
      createdAt: '2026-10-01T00:00:00Z',
      stageName: 'Production',
    },
    {
      id: 'rel-prod-new',
      name: 'v1.1',
      teamId: 'team-1',
      stagePosition: 1,
      createdAt: '2026-10-10T00:00:00Z',
      stageName: 'Production',
    },
    {
      id: 'rel-staging',
      name: 'v1.2',
      teamId: 'team-1',
      stagePosition: 0,
      createdAt: '2026-10-12T00:00:00Z',
      stageName: 'Staging',
    },
    {
      id: 'rel-draft',
      name: 'v1.3',
      teamId: 'team-1',
      stagePosition: -1,
      createdAt: '2026-10-14T00:00:00Z',
    },
  ],
  issueReleases: new Map([
    ['iss-shared', ['rel-staging', 'rel-prod-old']],
    ['iss-new', ['rel-prod-new']],
    ['iss-gone', ['rel-left']],
  ]),
};

const keys = (groups: { key: string }[]): string[] =>
  groups.map((group) => group.key);

const ids = (rows: OrderedIssueRead[]): string[] => rows.map((row) => row.id);

describe('grouping by release', () => {
  it('is offered only once releases are read', () => {
    expect(GROUP_FIELDS).toContain('release');
    expect(fieldsFor(GROUP_FIELDS, {})).not.toContain('release');
    expect(fieldsFor(GROUP_FIELDS, context)).toContain('release');
    expect(filterFieldsFor({ projects: [] })).not.toContain('release');
    expect(filterFieldsFor(context)).toContain('release');
    expect(isMovableGroupField('release')).toBe(false);
  });

  it('places an issue under every release that carries it and the rest under none', () => {
    const groups = groupIssues(
      [
        issue({ id: 'iss-shared' }),
        issue({ id: 'iss-new' }),
        issue({ id: 'iss-plain' }),
      ],
      'release',
      context,
      false
    );

    expect(keys(groups)).toEqual([
      'rel-staging',
      'rel-prod-new',
      'rel-prod-old',
      NONE,
    ]);
    expect(ids(groups[0]?.issues ?? [])).toEqual(['iss-shared']);
    expect(ids(groups[1]?.issues ?? [])).toEqual(['iss-new']);
    expect(ids(groups[2]?.issues ?? [])).toEqual(['iss-shared']);
    expect(ids(groups[3]?.issues ?? [])).toEqual(['iss-plain']);
    expect(groups[3]?.label).toBe('No release');
  });

  it('orders by pipeline stage then the newest first, No release last', () => {
    const groups = groupIssues([], 'release', context, true);

    expect(keys(groups)).toEqual([
      'rel-draft',
      'rel-staging',
      'rel-prod-new',
      'rel-prod-old',
      NONE,
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      'v1.3',
      'v1.2',
      'v1.1',
      'v1.0',
      'No release',
    ]);
    expect(
      releasesInOrder(context.releases ?? []).map((release) => release.id)
    ).toEqual(keys(groups).filter((key) => key !== NONE));
  });

  it('hides empty release groups unless the view shows them', () => {
    const groups = groupIssues(
      [issue({ id: 'iss-new' })],
      'release',
      context,
      false
    );

    expect(keys(groups)).toEqual(['rel-prod-new']);
  });

  it('gives a release it cannot name a group of its own', () => {
    const groups = groupIssues(
      [issue({ id: 'iss-gone' })],
      'release',
      context,
      false
    );

    expect(groups.map((group) => [group.key, group.label])).toEqual([
      ['rel-left', 'Unknown release'],
    ]);
  });

  it('works as a sub-grouping under another field', () => {
    const outer = groupIssues(
      [
        issue({ id: 'iss-shared', priority: 'urgent' }),
        issue({ id: 'iss-new', priority: 'urgent' }),
        issue({ id: 'iss-plain', priority: 'low' }),
      ],
      'priority',
      context,
      false
    );
    const urgent = outer.find((group) => group.key === 'urgent');
    const inner = groupIssues(urgent?.issues ?? [], 'release', context, false);

    expect(keys(inner)).toEqual([
      'rel-staging',
      'rel-prod-new',
      'rel-prod-old',
    ]);
  });

  it('refuses a drag between release columns', () => {
    expect(
      moveChange(
        issue({ id: 'iss-new' }),
        'release',
        'rel-prod-new',
        'rel-staging',
        context
      )
    ).toBeNull();
  });

  it('rides the URL as a grouping', () => {
    const base = defaultViewState('board');
    const state: ViewState = {
      ...base,
      groupBy: 'status',
      subGroupBy: 'release',
    };
    const params = writeViewState(state, base);

    expect(params.get('sub')).toBe('release');
    expect(sameViewState(parseViewState(params, base), state)).toBe(true);
  });
});

describe('the release filter', () => {
  it('writes release_id and release_id_not to the list query', () => {
    const base = defaultViewState('list');
    const query = viewStateQuery({
      ...base,
      filters: [{ field: 'release', op: 'is', values: ['rel-staging', NONE] }],
    });
    const excluded = viewStateQuery({
      ...base,
      filters: [{ field: 'release', op: 'is_not', values: ['rel-draft'] }],
    });

    expect(query.release_id).toEqual(['rel-staging', NONE]);
    expect(excluded.release_id_not).toEqual(['rel-draft']);
  });
});

describe('the release chip', () => {
  it('lists the releases carrying an issue, the newest first', () => {
    expect(
      releasesOf({ id: 'iss-shared' }, context).map((release) => release.id)
    ).toEqual(['rel-staging', 'rel-prod-old']);
    expect(releasesOf({ id: 'iss-plain' }, context)).toEqual([]);
  });
});

describe('the release index', () => {
  const entry = (
    fields: Partial<ReleaseIndexEntryRead>
  ): ReleaseIndexEntryRead => ({
    release_id: 'rel-1',
    team_id: 'team-1',
    name: 'v1.0',
    stage_position: -1,
    created_at: '2026-10-01T00:00:00Z',
    issue_ids: [],
    ...fields,
  });

  it('lists each release once per issue', () => {
    const byIssue = releasesByIssue([
      entry({ release_id: 'rel-2', issue_ids: ['iss-1', 'iss-2', 'iss-1'] }),
      entry({ release_id: 'rel-1', issue_ids: ['iss-1'] }),
    ]);

    expect([...byIssue.entries()]).toEqual([
      ['iss-1', ['rel-2', 'rel-1']],
      ['iss-2', ['rel-2']],
    ]);
  });
});
