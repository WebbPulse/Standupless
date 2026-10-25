/**
 * Prefilled new issue links: the query parses into raw values, each value
 * resolves by id or by name against the team's lists, unknown values drop
 * silently, and a link built from an issue carries its properties by id.
 */

import { describe, expect, it } from 'vitest';
import type {
  CycleRead,
  IssueRead,
  LabelRead,
  MilestoneRead,
  ProjectRead,
  StatusRead,
  TeamMemberRead,
  TeamRead,
  TemplateRead,
} from '../types/Api';
import {
  isNewIssuePath,
  newIssueBasePath,
  newIssuePath,
  parseNewIssueParams,
  prefilledFieldsOf,
  resolveNewIssueOptions,
  resolveTeam,
  type NewIssueLookups,
  type NewIssueParams,
} from './newIssueUrl';

/** Raw params with only the given values set. */
const params = (fields: Partial<NewIssueParams>): NewIssueParams => ({
  labels: [],
  links: [],
  ...fields,
});

const statuses = [
  { id: 'st-1', name: 'Todo' },
  { id: 'st-2', name: 'In Progress' },
] as StatusRead[];

const labels = [
  { id: 'lb-1', name: 'Bug' },
  { id: 'lb-2', name: 'Frontend' },
  { id: 'lb-3', name: 'Secret', hidden: true },
] as LabelRead[];

const people = [
  {
    user_id: 'user-2',
    display_name: 'ada',
    full_name: 'Ada Lovelace',
    email: 'ada@example.com',
  },
] as TeamMemberRead[];

const cycles = [
  {
    cycle_id: 'cy-1',
    number: 4,
    name: 'Sprint 4',
    status: 'completed',
    cancelled: false,
    start_date: '2026-10-01',
  },
  {
    cycle_id: 'cy-2',
    number: 5,
    name: 'Sprint 5',
    status: 'active',
    cancelled: false,
    start_date: '2026-10-15',
  },
  {
    cycle_id: 'cy-3',
    number: 6,
    name: 'Sprint 6',
    status: 'upcoming',
    cancelled: false,
    start_date: '2026-10-29',
  },
  {
    cycle_id: 'cy-4',
    number: 7,
    name: 'Dropped',
    status: 'cancelled',
    cancelled: true,
    start_date: '2026-11-12',
  },
] as CycleRead[];

const projects = [
  { project_id: 'prj-1', name: 'Launch' },
  { project_id: 'prj-2', name: 'Billing' },
] as ProjectRead[];

const milestones = [
  { milestone_id: 'ms-1', project_id: 'prj-1', name: 'Beta' },
  { milestone_id: 'ms-2', project_id: 'prj-2', name: 'Beta' },
] as MilestoneRead[];

const templates = [
  { id: 'tp-1', name: 'Bug report', kind: 'issue' },
  { id: 'tp-2', name: 'Launch plan', kind: 'project' },
] as TemplateRead[];

const lookups: NewIssueLookups = {
  viewerId: 'user-1',
  statuses,
  labels,
  people,
  cycles,
  projects,
  milestones,
  templates,
  estimates: ['1', '2', '3', '5'],
};

const teams = [
  { id: 'team-1', key_prefix: 'ENG', name: 'Engineering' },
  { id: 'team-2', key_prefix: 'OPS', name: 'Operations' },
] as TeamRead[];

describe('parseNewIssueParams', () => {
  it('reads plus as a space and trims single values', () => {
    const parsed = parseNewIssueParams(
      '?title=Crash+on+save&status=+Todo+&priority=high'
    );

    expect(parsed.title).toBe('Crash on save');
    expect(parsed.status).toBe('Todo');
    expect(parsed.priority).toBe('high');
  });

  it('keeps the description Markdown as written', () => {
    const parsed = parseNewIssueParams(
      `?description=${encodeURIComponent('## Steps\n\n1. Save\n')}`
    );

    expect(parsed.description).toBe('## Steps\n\n1. Save\n');
  });

  it('reads label and labels as comma separated lists', () => {
    const parsed = parseNewIssueParams('?labels=Bug,+Frontend&label=lb-9,');

    expect(parsed.labels).toEqual(['Bug', 'Frontend', 'lb-9']);
  });

  it('reads links as url and title pairs and drops ones that are not web links', () => {
    const parsed = parseNewIssueParams(
      `?links=${encodeURIComponent(
        'https://example.com/log|Log,http://example.com,javascript:alert(1),nope'
      )}`
    );

    expect(parsed.links).toEqual([
      { url: 'https://example.com/log', title: 'Log' },
      { url: 'http://example.com' },
    ]);
  });

  it('leaves blank values out', () => {
    const parsed = parseNewIssueParams('?title=&status=++&labels=,');

    expect(parsed).toEqual({ labels: [], links: [] });
  });
});

describe('resolveTeam', () => {
  it('matches by id, key prefix or name', () => {
    expect(resolveTeam('team-2', teams)?.id).toBe('team-2');
    expect(resolveTeam('eng', teams)?.id).toBe('team-1');
    expect(resolveTeam('Operations', teams)?.id).toBe('team-2');
    expect(resolveTeam('Design', teams)).toBeUndefined();
  });
});

describe('resolveNewIssueOptions', () => {
  it('resolves every field by id', () => {
    const options = resolveNewIssueOptions(
      params({
        status: 'st-2',
        assignee: 'user-2',
        cycle: 'cy-3',
        labels: ['lb-1', 'lb-2'],
        project: 'prj-1',
        projectMilestone: 'ms-1',
        template: 'tp-1',
      }),
      lookups
    );

    expect(options).toEqual({
      statusId: 'st-2',
      assigneeId: 'user-2',
      cycleId: 'cy-3',
      labelIds: ['lb-1', 'lb-2'],
      projectId: 'prj-1',
      projectMilestoneId: 'ms-1',
      templateId: 'tp-1',
    });
  });

  it('resolves every field by name, ignoring case', () => {
    const options = resolveNewIssueOptions(
      params({
        title: 'Crash on save',
        description: 'It crashes.',
        priority: 'URGENT',
        status: 'in progress',
        assignee: 'Ada Lovelace',
        estimate: '3',
        cycle: 'sprint 4',
        labels: ['bug', 'Frontend'],
        project: 'billing',
        projectMilestone: 'beta',
        template: 'bug report',
      }),
      lookups
    );

    expect(options).toEqual({
      title: 'Crash on save',
      description: 'It crashes.',
      priority: 'urgent',
      statusId: 'st-2',
      assigneeId: 'user-2',
      estimate: '3',
      cycleId: 'cy-1',
      labelIds: ['lb-1', 'lb-2'],
      projectId: 'prj-2',
      projectMilestoneId: 'ms-2',
      templateId: 'tp-1',
    });
  });

  it('reads me as the signed in person and matches people by display name or email', () => {
    expect(resolveNewIssueOptions(params({ assignee: 'Me' }), lookups)).toEqual(
      { assigneeId: 'user-1' }
    );
    expect(
      resolveNewIssueOptions(params({ assignee: 'ada' }), lookups).assigneeId
    ).toBe('user-2');
    expect(
      resolveNewIssueOptions(params({ assignee: 'ada@example.com' }), lookups)
        .assigneeId
    ).toBe('user-2');
  });

  it('reads current, next and a cycle number', () => {
    const cycleOf = (cycle: string): string | undefined =>
      resolveNewIssueOptions(params({ cycle }), lookups).cycleId;

    expect(cycleOf('current')).toBe('cy-2');
    expect(cycleOf('next')).toBe('cy-3');
    expect(cycleOf('6')).toBe('cy-3');
    expect(cycleOf('7')).toBeUndefined();
    expect(cycleOf('Dropped')).toBeUndefined();
  });

  it('drops values that match nothing and keeps the rest', () => {
    const options = resolveNewIssueOptions(
      params({
        title: 'Still here',
        priority: 'whenever',
        status: 'Shipped',
        assignee: 'nobody',
        estimate: '4',
        cycle: 'Sprint 99',
        labels: ['Bug', 'Missing', 'Secret', 'bug'],
        project: 'Unknown',
        projectMilestone: 'Beta',
        template: 'Launch plan',
      }),
      lookups
    );

    expect(options).toEqual({ title: 'Still here', labelIds: ['lb-1'] });
  });

  it('ignores a milestone without a project', () => {
    expect(
      resolveNewIssueOptions(params({ projectMilestone: 'ms-1' }), lookups)
    ).toEqual({});
  });

  it('passes links through for the dialog to attach', () => {
    const links = [{ url: 'https://example.com', title: 'Spec' }];

    expect(resolveNewIssueOptions(params({ links }), lookups)).toEqual({
      links,
    });
  });

  it('drops looked up values when the lists are missing', () => {
    expect(
      resolveNewIssueOptions(
        params({ status: 'Todo', labels: ['Bug'], estimate: '1' }),
        {}
      )
    ).toEqual({});
  });
});

describe('the create routes', () => {
  it('recognises the workspace and team create paths', () => {
    expect(isNewIssuePath('/w/mine/new')).toBe(true);
    expect(isNewIssuePath('/w/mine/team/ENG/new')).toBe(true);
    expect(isNewIssuePath('/w/mine/issues/ENG-1')).toBe(false);
    expect(isNewIssuePath('/w/mine/new/extra')).toBe(false);
  });

  it('builds the base path for a workspace or a team', () => {
    expect(newIssueBasePath('mine')).toBe('/w/mine/new');
    expect(newIssueBasePath('mine', 'ENG')).toBe('/w/mine/team/ENG/new');
  });

  it('builds a query that parses back to the same values', () => {
    const path = newIssuePath(
      'mine',
      {
        title: 'Crash on save',
        priority: 'high',
        labels: ['lb-1', 'lb-2'],
        project: 'prj-1',
        projectMilestone: 'ms-1',
        links: [{ url: 'https://example.com/log', title: 'Log' }],
      },
      'ENG'
    );

    expect(path.startsWith('/w/mine/team/ENG/new?')).toBe(true);
    expect(parseNewIssueParams(path.slice(path.indexOf('?')))).toEqual({
      title: 'Crash on save',
      priority: 'high',
      labels: ['lb-1', 'lb-2'],
      project: 'prj-1',
      projectMilestone: 'ms-1',
      links: [{ url: 'https://example.com/log', title: 'Log' }],
    });
  });

  it('leaves out no priority and a milestone without a project', () => {
    expect(
      newIssuePath('mine', { priority: 'none', projectMilestone: 'ms-1' })
    ).toBe('/w/mine/new');
  });

  it('carries an issue properties by id', () => {
    const issue = {
      team_id: 'team-1',
      status_id: 'st-2',
      priority: 'low',
      label_ids: ['lb-1'],
      project_id: null,
      assignee_id: null,
    } as unknown as IssueRead;

    expect(prefilledFieldsOf(issue)).toEqual({
      team: 'team-1',
      status: 'st-2',
      priority: 'low',
      labels: ['lb-1'],
    });
  });
});
