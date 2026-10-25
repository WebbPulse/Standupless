/**
 * The create dialog's triage duty line: who is notified, who is assigned in
 * turn, and when it stays quiet.
 */

import { describe, expect, it } from 'vitest';
import type { Assignable } from './issuePeople';
import { triageDutyLine } from './triageDuty';
import type { TriageSettingsRead } from '../types/Api';

const PEOPLE: Assignable[] = [
  { user_id: 'u-ada', email: 'ada@example.com', display_name: 'ada' },
  { user_id: 'u-bo', email: 'bo@example.com', display_name: 'bo' },
  { user_id: 'u-cy', email: 'cy@example.com', display_name: 'cy' },
];

const settings = (
  extra: Partial<TriageSettingsRead> = {}
): TriageSettingsRead => ({
  team_id: 'team-1',
  enabled: true,
  responsible_user_ids: ['u-ada', 'u-bo'],
  responsibility_action: 'notify',
  require_priority: false,
  updated_at: null,
  ...extra,
});

describe('triageDutyLine', () => {
  it('names everyone notified', () => {
    expect(triageDutyLine(settings(), PEOPLE, null)).toBe(
      'Triage duty: ada and bo will be notified.'
    );
  });

  it('lists three names with a comma', () => {
    expect(
      triageDutyLine(
        settings({ responsible_user_ids: ['u-ada', 'u-bo', 'u-cy'] }),
        PEOPLE,
        null
      )
    ).toBe('Triage duty: ada, bo and cy will be notified.');
  });

  it('says one of them is assigned under round robin', () => {
    expect(
      triageDutyLine(
        settings({ responsibility_action: 'assign' }),
        PEOPLE,
        null
      )
    ).toBe('Triage duty: one of ada and bo will be assigned this issue.');
  });

  it('names the single person assigned', () => {
    expect(
      triageDutyLine(
        settings({
          responsibility_action: 'assign',
          responsible_user_ids: ['u-bo'],
        }),
        PEOPLE,
        null
      )
    ).toBe('Triage duty: bo will be assigned this issue.');
  });

  it('stays quiet when an assign team issue already has an assignee', () => {
    expect(
      triageDutyLine(
        settings({ responsibility_action: 'assign' }),
        PEOPLE,
        'u-cy'
      )
    ).toBeNull();
  });

  it('stays quiet with nobody on duty or triage off', () => {
    expect(
      triageDutyLine(settings({ responsible_user_ids: [] }), PEOPLE, null)
    ).toBeNull();
    expect(
      triageDutyLine(settings({ enabled: false }), PEOPLE, null)
    ).toBeNull();
    expect(triageDutyLine(null, PEOPLE, null)).toBeNull();
  });

  it('skips people the page does not know', () => {
    expect(
      triageDutyLine(
        settings({ responsible_user_ids: ['u-ada', 'u-gone'] }),
        PEOPLE,
        null
      )
    ).toBe('Triage duty: ada will be notified.');
  });
});
