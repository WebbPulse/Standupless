/**
 * Grouping by one label group: each group is offered after the plain label
 * grouping, every issue falls in the column of its label from the group or in
 * No <group>, a drag swaps the label within the group, and the grouping rides
 * the URL and a saved view.
 */

import { describe, expect, it } from 'vitest';
import { NONE, type OrderedIssueRead } from '../api/issues';
import type { SavedViewDisplayRead } from '../api/views';
import {
  defaultViewState,
  groupFieldLabel,
  groupFieldsFor,
  groupIssues,
  groupKeysOf,
  isLabelGroupField,
  isMovableGroupField,
  labelGroupField,
  moveChange,
  parseViewState,
  sameViewState,
  stateToViewBody,
  viewToState,
  writeViewState,
  type IssueContext,
  type ScopedLabel,
} from './issueView';
import { withGroupNames } from './labelGroups';

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
  created_at: '2026-09-17T00:00:00Z',
  updated_at: '2026-09-17T00:00:00Z',
  ...fields,
});

const label = (
  id: string,
  name: string,
  fields: Partial<ScopedLabel> = {}
): ScopedLabel => ({ id, name, color: '#888888', ...fields });

const labels: ScopedLabel[] = withGroupNames([
  label('grp-area', 'Area', { is_group: true, team_id: 'team-1' }),
  label('lb-api', 'API', { parent_id: 'grp-area', team_id: 'team-1' }),
  label('lb-web', 'Web', { parent_id: 'grp-area', team_id: 'team-1' }),
  label('grp-type', 'Type', { is_group: true, team_id: 'team-1' }),
  label('lb-bug', 'Bug', { parent_id: 'grp-type', team_id: 'team-1' }),
  label('lb-loose', 'Loose', { team_id: 'team-1' }),
  label('grp-area-2', 'Area', { is_group: true, team_id: 'team-2' }),
  label('lb-api-2', 'API', { parent_id: 'grp-area-2', team_id: 'team-2' }),
]);

const context: IssueContext = {
  statuses: [],
  labels,
  people: [],
  projects: [],
  cycles: [],
};

const area = labelGroupField('grp-area');

describe('label group grouping', () => {
  it('offers each label group once, after the plain label grouping', () => {
    const fields = groupFieldsFor(context);
    const at = fields.indexOf('label');

    expect(fields.slice(at, at + 3)).toEqual([
      'label',
      'label_group:grp-area',
      'label_group:grp-type',
    ]);
    expect(fields.filter(isLabelGroupField)).toHaveLength(2);
    expect(groupFieldLabel(area, context)).toBe('Area');
    expect(groupFieldLabel('label_group:gone', context)).toBe('Label group');
    expect(groupFieldLabel('status', context)).toBe('Status');
    expect(isMovableGroupField(area)).toBe(true);
    expect(isMovableGroupField('team')).toBe(false);
  });

  it('puts each issue in the column of its label from the group', () => {
    const api = issue({ id: 'a', label_ids: ['lb-api', 'lb-bug'] });
    const web = issue({ id: 'w', label_ids: ['lb-web'] });
    const bare = issue({ id: 'b', label_ids: ['lb-loose'] });
    const other = issue({
      id: 'o',
      team_id: 'team-2',
      label_ids: ['lb-api-2'],
    });

    expect(groupKeysOf(api, area, context)).toEqual(['area/api']);
    expect(groupKeysOf(bare, area, context)).toEqual([NONE]);

    const groups = groupIssues([api, web, bare, other], area, context, true);

    expect(groups.map((group) => [group.label, group.issues.length])).toEqual([
      ['No Area', 1],
      ['API', 2],
      ['Web', 1],
    ]);
    expect(groups.every((group) => group.field === area)).toBe(true);
  });

  it('shows only No <group> while the group is unknown', () => {
    const groups = groupIssues(
      [issue({ label_ids: ['lb-api'] })],
      'label_group:gone',
      context,
      true
    );

    expect(groups.map((group) => group.label)).toEqual(['No Label group']);
  });

  it('swaps the label within the group when a card moves', () => {
    const api = issue({ label_ids: ['lb-api', 'lb-bug'] });

    expect(moveChange(api, area, 'area/api', 'area/web', context)).toEqual({
      add_label_ids: ['lb-web'],
      remove_label_ids: ['lb-api'],
    });
    expect(moveChange(api, area, 'area/api', NONE, context)).toEqual({
      remove_label_ids: ['lb-api'],
    });
    expect(
      moveChange(issue({ label_ids: [] }), area, NONE, 'area/web', context)
    ).toEqual({ add_label_ids: ['lb-web'] });
    expect(
      moveChange(
        issue({ team_id: 'team-2', label_ids: ['lb-api-2'] }),
        area,
        'area/api',
        'area/web',
        context
      )
    ).toBeNull();
  });

  it('rides the URL and a saved view', () => {
    const base = defaultViewState('board');
    const grouped = {
      ...base,
      groupBy: area,
      subGroupBy: labelGroupField('grp-type'),
    };
    const params = writeViewState(grouped, base);

    expect(params.get('group')).toBe('label_group:grp-area');
    expect(sameViewState(parseViewState(params, base), grouped)).toBe(true);

    const body = stateToViewBody(grouped, 'By area');
    expect(body).toMatchObject({
      group_by: 'label_group:grp-area',
      sub_group_by: 'label_group:grp-type',
    });
    const view = {
      view_id: 'v-1',
      ...body,
      team_id: null,
    } as unknown as SavedViewDisplayRead;
    expect(sameViewState(viewToState(view), grouped)).toBe(true);
  });
});
