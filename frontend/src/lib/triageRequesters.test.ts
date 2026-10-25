/**
 * The triage requester filter and grouping: a choice turns into the list
 * route's requester query, rows group by who asked with the no-requester
 * group last, and the filter offers the sources and each person seen.
 */

import { describe, expect, it } from 'vitest';
import type { IssueRead, IssueRequester } from '../types/Api';
import {
  NO_REQUESTER,
  groupByRequester,
  requesterChoices,
  requesterGroupKey,
  requesterQuery,
} from './triageRequesters';

/** A waiting issue with the given id and requester. */
const issue = (id: string, requester?: IssueRequester): IssueRead =>
  ({
    id,
    key: `ENG-${id}`,
    title: id,
    ...(requester === undefined ? {} : { requester }),
  }) as IssueRead;

const slackSam: IssueRequester = {
  source: 'slack',
  name: 'Sam',
  handle: 'sam',
  external_id: 'U2',
};
const linkedMia: IssueRequester = {
  source: 'slack',
  name: 'Mia',
  external_id: 'U1',
  user_id: 'user-1',
};
const emailEve: IssueRequester = {
  source: 'email',
  name: 'Eve',
  masked_email: 'e***@example.com',
};

describe('requesterQuery', () => {
  it('maps each choice to the route parameter it narrows by', () => {
    expect(requesterQuery('member:user-1')).toEqual({
      requester_user_id: 'user-1',
    });
    expect(requesterQuery('slack:U2')).toEqual({
      requester_slack_user_id: 'U2',
    });
    expect(requesterQuery('source:email')).toEqual({
      requester_source: 'email',
    });
    expect(requesterQuery(NO_REQUESTER)).toEqual({ requester_source: 'none' });
  });

  it('sends nothing for any requester or a value it does not know', () => {
    expect(requesterQuery('')).toEqual({});
    expect(requesterQuery('source:fax')).toEqual({});
    expect(requesterQuery('member:')).toEqual({});
  });
});

describe('groupByRequester', () => {
  it('groups by person in first-seen order and puts no requester last', () => {
    const rows = [
      issue('1'),
      issue('2', slackSam),
      issue('3', linkedMia),
      issue('4', slackSam),
      issue('5', emailEve),
    ];

    const groups = groupByRequester(rows, [
      {
        user_id: 'user-1',
        email: 'mia@example.com',
        display_name: 'mia',
        avatar_url: null,
        full_name: '',
      },
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      'Sam',
      'mia',
      'Eve',
      'No requester',
    ]);
    expect(groups.map((group) => group.rows.map((row) => row.id))).toEqual([
      ['2', '4'],
      ['3'],
      ['5'],
      ['1'],
    ]);
  });

  it('keys a linked member by the member and a stranger by their Slack id', () => {
    expect(requesterGroupKey(issue('1', linkedMia))).toBe('member:user-1');
    expect(requesterGroupKey(issue('2', slackSam))).toBe('slack:U2');
    expect(requesterGroupKey(issue('3'))).toBe(NO_REQUESTER);
  });
});

describe('requesterChoices', () => {
  it('offers the sources, then each filterable person seen once', () => {
    const choices = requesterChoices(
      [issue('1', slackSam), issue('2', slackSam), issue('3', emailEve)],
      [],
      null
    );

    expect(choices.map((choice) => choice.value)).toEqual([
      'source:slack',
      'source:email',
      NO_REQUESTER,
      'slack:U2',
    ]);
    expect(choices[3]).toMatchObject({ label: 'Sam', detail: '@sam' });
  });

  it('keeps the chosen person when the rows no longer show them', () => {
    const chosen = { value: 'slack:U9', label: 'Gone', group: 'Requester' };

    const choices = requesterChoices([], [], chosen);

    expect(choices.at(-1)).toEqual(chosen);
  });
});
