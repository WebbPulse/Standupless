/**
 * The property values the palette offers on issues in focus: each reads as
 * the action it takes, a value every target already has is left out except a
 * label, which reads as removing it, a team with estimates off offers none,
 * and running one writes through the view's update the way the picker does,
 * landing a status on each issue's own team's status of that name.
 */

import { describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../../../api/issues';
import type { IssueWrite } from '../../../hooks/useOptimisticIssues';
import type { IssueChange, IssueContext } from '../../../lib/issueView';
import type { EstimateScale } from '../../../types/Api';
import type { IssueViewEnv } from './IssueViewContext';
import { propertyValues } from './propertyValues';

/** An issue on a team, with the fields the values read. */
const issueOn = (
  id: string,
  teamId: string,
  overrides: Partial<OrderedIssueRead> = {}
): OrderedIssueRead =>
  ({
    id,
    key: `ENG-${id}`,
    title: `Issue ${id}`,
    team_id: teamId,
    status_id: `${teamId}-todo`,
    priority: 'high',
    assignee_id: null,
    label_ids: [],
    estimate: null,
    start_date: null,
    due_date: null,
    cycle_id: null,
    project_id: null,
    ...overrides,
  }) as OrderedIssueRead;

/** Two teams, each with its own Todo and Done. */
const context: IssueContext = {
  statuses: ['team-1', 'team-2'].flatMap((teamId) => [
    {
      id: `${teamId}-todo`,
      name: 'Todo',
      category: 'unstarted' as const,
      position: 0,
      team_id: teamId,
    },
    {
      id: `${teamId}-done`,
      name: 'Done',
      category: 'completed' as const,
      position: 1,
      team_id: teamId,
    },
  ]),
  labels: [
    { id: 'lb-1', name: 'Bug', color: '#f00', team_id: 'team-1' },
    { id: 'lb-2', name: 'Infra', color: '#0f0', team_id: 'team-1' },
  ],
  people: [
    { user_id: 'user-1', email: 'me@example.com', display_name: 'Me' },
    { user_id: 'user-2', email: 'alex@example.com', display_name: 'Alex' },
  ],
  projects: [],
  cycles: [],
  currentUserId: 'user-1',
};

/** A view env over the context that records its writes. */
const envWith = (
  update: IssueWrite,
  scale: EstimateScale = 'off'
): IssueViewEnv =>
  ({
    context,
    forTeam: () => context,
    scaleFor: () => scale,
    canEdit: true,
    update,
  }) as unknown as IssueViewEnv;

/** The values for the issues, as the palette reads them. */
const valuesFor = (
  issues: OrderedIssueRead[],
  update: IssueWrite = vi.fn(),
  scale: EstimateScale = 'off'
) =>
  propertyValues({
    issues,
    env: envWith(update, scale),
    triageTeams: new Set(),
    today: new Date('2026-10-24T12:00:00Z'),
  });

/** The labels the values read as. */
const labelsOf = (issues: OrderedIssueRead[], scale?: EstimateScale) =>
  valuesFor(issues, vi.fn(), scale).map((value) => value.label);

describe('propertyValues', () => {
  it('phrases each value as the action it takes', () => {
    const labels = labelsOf([issueOn('1', 'team-1')]);

    expect(labels).toContain('Change status to Done');
    expect(labels).toContain('Set priority to Urgent');
    expect(labels).toContain('Assign to Alex');
    expect(labels).toContain('Add label Bug');
  });

  it('checks the values every target already has and makes them inert', () => {
    const update = vi.fn<IssueWrite>();
    const applied = valuesFor([issueOn('1', 'team-1')], update).filter(
      (value) => value.inert === true
    );

    expect(applied.map((value) => value.label)).toEqual(
      expect.arrayContaining([
        'Change status to Todo',
        'Set priority to High',
        'Unassign',
      ])
    );
    expect(applied.every((value) => value.checked === true)).toBe(true);
    applied.forEach((value) => {
      value.run();
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('tags each value with its property', () => {
    const urgent = valuesFor([issueOn('1', 'team-1')]).find(
      (value) => value.label === 'Set priority to Urgent'
    );

    expect(urgent?.property).toBe('priority');
    expect(urgent?.checked).toBe(false);
  });

  it('offers removing a label every target carries', () => {
    const labels = labelsOf([issueOn('1', 'team-1', { label_ids: ['lb-1'] })]);

    expect(labels).toContain('Remove label Bug');
    expect(labels).toContain('Add label Infra');
    const bug = valuesFor([
      issueOn('1', 'team-1', { label_ids: ['lb-1'] }),
    ]).find((value) => value.label === 'Remove label Bug');
    expect(bug?.checked).toBe(true);
    expect(bug?.inert).toBe(false);
  });

  it('offers no estimates while the team has them off', () => {
    expect(
      labelsOf([issueOn('1', 'team-1')]).some((label) =>
        label.includes('estimate')
      )
    ).toBe(false);
    expect(labelsOf([issueOn('1', 'team-1')], 'tshirt')).toContain(
      'Set estimate to M'
    );
  });

  it('writes a priority to every target in one change', () => {
    const update = vi.fn<IssueWrite>();
    const issues = [issueOn('1', 'team-1'), issueOn('2', 'team-1')];

    valuesFor(issues, update)
      .find((value) => value.label === 'Set priority to Urgent')
      ?.run();

    expect(update).toHaveBeenCalledWith(['1', '2'], { priority: 'urgent' });
  });

  it("lands a status on each issue's own team's status of that name", () => {
    const update = vi.fn<IssueWrite>();
    const first = issueOn('1', 'team-1');
    const second = issueOn('2', 'team-2');

    valuesFor([first, second], update)
      .find((value) => value.label === 'Change status to Done')
      ?.run();

    const [ids, change] = update.mock.calls[0] ?? [];
    expect(ids).toEqual(['1', '2']);
    const perIssue = change as (issue: OrderedIssueRead) => IssueChange | null;
    expect(perIssue(first)).toEqual({ status_id: 'team-1-done' });
    expect(perIssue(second)).toEqual({ status_id: 'team-2-done' });
  });

  it('names the value so a match on it can rank first', () => {
    const urgent = valuesFor([issueOn('1', 'team-1')]).find(
      (value) => value.label === 'Set priority to Urgent'
    );

    expect(urgent?.name).toBe('Urgent');
    expect(urgent?.keywords).toContain('priority');
  });

  it('offers the due date presets and removing a set due date', () => {
    const none = labelsOf([issueOn('1', 'team-1')]);
    expect(none).toContain('Set due date to Tomorrow');
    expect(none).not.toContain('Remove due date');

    const due = valuesFor([
      issueOn('1', 'team-1', { due_date: '2026-11-20' }),
    ]).find((value) => value.label === 'Remove due date');
    expect(due?.name).toBe('Remove due date');
    expect(due?.property).toBe('dueDate');
  });

  it('leads the due dates with the day a typed term names', () => {
    const values = propertyValues({
      issues: [issueOn('1', 'team-1')],
      env: envWith(vi.fn()),
      triageTeams: new Set(),
      today: new Date('2026-10-24T12:00:00Z'),
      query: 'nov 3',
    });
    const lead = values.find((value) => value.lead === true);

    expect(lead?.property).toBe('dueDate');
    expect(lead?.id).toBe('dueDate-typed-2026-11-03');
  });

  it('keeps every id unique when two presets land on one day', () => {
    const values = propertyValues({
      issues: [issueOn('1', 'team-1')],
      env: envWith(vi.fn()),
      triageTeams: new Set(),
      today: new Date(2026, 9, 29, 12),
    });
    const ids = values.map((value) => value.id);
    const day = 'dueDate-2026-10-30';
    const tomorrow = values.filter((value) => value.id.startsWith(day));

    expect(new Set(ids).size).toBe(ids.length);
    expect(tomorrow.map((value) => value.name)).toEqual([
      'Tomorrow',
      'End of this week',
    ]);
  });

  it('offers milestones only for an issue in a project the view names', () => {
    const update = vi.fn<IssueWrite>();
    const milestone = {
      milestone_id: 'ms-1',
      project_id: 'pr-1',
      name: 'Beta',
    };
    const env = {
      ...envWith(update),
      context: { ...context, milestones: [milestone] },
    } as unknown as IssueViewEnv;
    const offered = (issue: OrderedIssueRead) =>
      propertyValues({
        issues: [issue],
        env,
        triageTeams: new Set(),
        today: new Date('2026-10-24T12:00:00Z'),
      }).map((value) => value.label);

    expect(offered(issueOn('1', 'team-1'))).not.toContain(
      'Set milestone to Beta'
    );
    expect(
      labelsOf([issueOn('1', 'team-1', { project_id: 'pr-1' })])
    ).not.toContain('Set milestone to Beta');
    expect(offered(issueOn('1', 'team-1', { project_id: 'pr-1' }))).toContain(
      'Set milestone to Beta'
    );
  });

  it('marks a label as toggling', () => {
    const bug = valuesFor([issueOn('1', 'team-1')]).find(
      (value) => value.label === 'Add label Bug'
    );

    expect(bug?.toggles).toBe(true);
  });

  it('offers nothing with no issue in focus', () => {
    expect(valuesFor([])).toEqual([]);
  });
});
