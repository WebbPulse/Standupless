/**
 * The standup page helpers: a daily digest steps over weekends, a weekly one
 * moves a week at a time, and lines group by project with the loose ones first.
 */

import { describe, expect, it } from 'vitest';
import { byProject, hasLines, shiftDigestDate } from './standup';
import type { StandupItem, StandupPerson } from '../types/Api';

const item = (key: string, project: string | null): StandupItem => ({
  issue_id: key,
  key,
  title: key,
  status_id: 's',
  project_id: project,
  project_name: project === null ? null : `Project ${project}`,
  due_date: null,
  at: null,
  count: 0,
});

const person = (overrides: Partial<StandupPerson> = {}): StandupPerson => ({
  user_id: 'u',
  display_name: 'Ada',
  note: null,
  completed: [],
  started: [],
  commented: [],
  blocked: [],
  overdue: [],
  due_soon: [],
  project_updates: [],
  ...overrides,
});

describe('shiftDigestDate', () => {
  it('steps a daily digest over the weekend', () => {
    expect(shiftDigestDate('2026-10-09', 1, 'daily')).toBe('2026-10-12');
    expect(shiftDigestDate('2026-10-12', -1, 'daily')).toBe('2026-10-09');
  });

  it('moves a weekly digest by seven days', () => {
    expect(shiftDigestDate('2026-10-07', 1, 'weekly')).toBe('2026-10-14');
    expect(shiftDigestDate('2026-10-07', -1, 'weekly')).toBe('2026-09-30');
  });
});

describe('byProject', () => {
  it('puts issues with no project first, then projects by name', () => {
    const groups = byProject([
      item('A-1', 'b'),
      item('A-2', null),
      item('A-3', 'a'),
    ]);
    expect(groups.map((group) => group.projectId)).toEqual([null, 'a', 'b']);
  });
});

describe('hasLines', () => {
  it('treats a person with nothing as empty', () => {
    expect(hasLines(person())).toBe(false);
    expect(hasLines(person({ note: 'Out today' }))).toBe(true);
    expect(hasLines(person({ started: [item('A-1', null)] }))).toBe(true);
  });
});
