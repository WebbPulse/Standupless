/** Tests for how a project activity row reads. */

import { describe, expect, it } from 'vitest';
import type { ProjectActivityRead } from '../types/Api';
import {
  describeProjectActivity,
  type ProjectActivityLookups,
} from './projectActivityDisplay';

const lookups: ProjectActivityLookups = {
  people: [
    {
      user_id: 'user-1',
      email: 'ada@example.com',
      display_name: 'Ada',
      avatar_url: null,
      full_name: '',
    },
    {
      user_id: 'user-2',
      email: 'grace@example.com',
      display_name: 'Grace',
      avatar_url: null,
      full_name: '',
    },
  ],
  teams: [
    { id: 'team-1', name: 'Engine' },
    { id: 'team-2', name: 'Web' },
  ],
  initiatives: [{ initiative_id: 'ini-1', name: 'Grow' }],
  milestones: [{ milestone_id: 'ms-1', name: 'Beta' }],
};

const row = (overrides: Partial<ProjectActivityRead>): ProjectActivityRead => ({
  activity_id: 'act-1',
  project_id: 'prj-1',
  actor_id: 'user-1',
  kind: 'field_changed',
  field: null,
  from: null,
  to: null,
  milestone_id: null,
  created_at: '2026-10-01T00:00:00Z',
  ...overrides,
});

const sentence = (overrides: Partial<ProjectActivityRead>): string =>
  describeProjectActivity(row(overrides), lookups)
    .parts.map((part) => part.text)
    .join('');

describe('describeProjectActivity', () => {
  it('reads a created project', () => {
    const description = describeProjectActivity(
      row({ kind: 'created' }),
      lookups
    );
    expect(description.icon).toBe('created');
    expect(sentence({ kind: 'created' })).toBe('created the project');
  });

  it('reads an archive and a restore', () => {
    expect(sentence({ kind: 'archived' })).toBe('archived the project');
    expect(sentence({ kind: 'unarchived' })).toBe('restored the project');
  });

  it('reads a status move with both statuses as glyphs', () => {
    const description = describeProjectActivity(
      row({ field: 'status', from: 'backlog', to: 'in_progress' }),
      lookups
    );
    expect(description.parts.map((part) => part.kind)).toEqual([
      'text',
      'status',
      'text',
      'status',
    ]);
    expect(
      sentence({ field: 'status', from: 'backlog', to: 'in_progress' })
    ).toBe('changed the status from Backlog to In progress');
  });

  it('reads priority, health and dates, set and cleared', () => {
    expect(sentence({ field: 'priority', from: 'none', to: 'high' })).toBe(
      'set the priority to High'
    );
    expect(sentence({ field: 'priority', from: 'high', to: 'none' })).toBe(
      'removed the priority'
    );
    expect(sentence({ field: 'health', to: 'at_risk' })).toBe(
      'set the health to At risk'
    );
    expect(sentence({ field: 'health', from: 'at_risk', to: null })).toBe(
      'cleared the health'
    );
    expect(sentence({ field: 'target_date', from: '2026-12-01' })).toBe(
      'removed the target date'
    );
    expect(sentence({ field: 'start_date', to: '2026-12-01' })).toMatch(
      /^set the start date to /
    );
  });

  it('names people, teams and the initiative', () => {
    expect(sentence({ field: 'lead_id', to: 'user-2' })).toBe(
      'set the lead to Grace'
    );
    expect(sentence({ field: 'lead_id', from: 'user-2' })).toBe(
      'removed Grace as lead'
    );
    expect(
      sentence({ field: 'member_ids', from: ['user-1'], to: ['user-2'] })
    ).toBe('added Grace as members and removed Ada as members');
    expect(
      sentence({ field: 'team_ids', from: [], to: ['team-1', 'team-2'] })
    ).toBe('added Engine and Web as teams');
    expect(sentence({ field: 'initiative_id', to: 'ini-1' })).toBe(
      'moved the project to Grow'
    );
    expect(sentence({ field: 'name', to: 'Launch' })).toBe(
      'renamed the project to Launch'
    );
  });

  it('reads milestone changes by name', () => {
    expect(sentence({ kind: 'milestone_added', to: 'Beta' })).toBe(
      'added milestone Beta'
    );
    expect(sentence({ kind: 'milestone_removed', from: 'Beta' })).toBe(
      'removed milestone Beta'
    );
    expect(
      sentence({
        kind: 'milestone_changed',
        field: 'name',
        from: 'Alpha',
        to: 'Beta',
      })
    ).toBe('renamed milestone Alpha to Beta');
    expect(
      sentence({
        kind: 'milestone_changed',
        field: 'target_date',
        milestone_id: 'ms-1',
        from: '2026-11-01',
        to: null,
      })
    ).toBe('removed the target date of milestone Beta');
  });

  it('reads a Resources link added, retitled, repointed and removed', () => {
    const description = describeProjectActivity(
      row({ kind: 'link_added', to: 'docs.example.com', link_id: 'lnk-1' }),
      lookups
    );
    expect(description.icon).toBe('link');
    expect(sentence({ kind: 'link_added', to: 'docs.example.com' })).toBe(
      'added link docs.example.com'
    );
    expect(sentence({ kind: 'link_removed', from: 'Spec' })).toBe(
      'removed link Spec'
    );
    expect(
      sentence({ kind: 'link_changed', field: 'title', from: null, to: 'Spec' })
    ).toBe('titled a link Spec');
    expect(
      sentence({
        kind: 'link_changed',
        field: 'title',
        from: 'Spec',
        to: 'Design spec',
      })
    ).toBe('renamed link Spec to Design spec');
    expect(
      sentence({ kind: 'link_changed', field: 'title', from: 'Spec', to: null })
    ).toBe('removed the title of link Spec');
    expect(
      sentence({
        kind: 'link_changed',
        field: 'url',
        from: 'https://a.example.com',
        to: 'https://figma.com/file/1',
      })
    ).toBe('pointed a link at figma.com');
  });
});
