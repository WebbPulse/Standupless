/** The Teams and API keys CSV rows: columns, escaping and no secrets. */

import { describe, expect, it } from 'vitest';
import type { ApiKeyCreatedRead, MemberRead, TeamRead } from '../types/Api';
import { toCsv } from './csv';
import { apiKeyCsvRows, teamCsvRows } from './settingsCsv';

const team = (over: Partial<TeamRead> = {}): TeamRead => ({
  id: 'team-1',
  workspace_id: 'ws-1',
  name: 'Engine',
  key_prefix: 'ENG',
  description: null,
  estimate_scale: 'off',
  created_at: '2026-09-17T08:00:00Z',
  updated_at: '2026-09-17T08:00:00Z',
  member_count: 4,
  ...over,
});

const member = (over: Partial<MemberRead> = {}): MemberRead => ({
  user_id: 'user-1',
  email: 'ada@example.com',
  display_name: 'ada',
  full_name: 'Ada Lovelace',
  role: 'admin',
  joined_at: '2026-09-01T00:00:00Z',
  ...over,
});

const minted: ApiKeyCreatedRead = {
  key_id: 'key-1',
  name: 'Shell',
  kind: 'user',
  prefix: 'wpk_abcd1234',
  scopes: ['issues:read', 'teams:read'],
  created_by: 'user-1',
  created_at: '2026-09-18T00:00:00Z',
  expires_at: '2026-12-01T00:00:00Z',
  last_used_at: null,
  revoked_at: null,
  secret: 'wpk_plaintext',
};

describe('teamCsvRows', () => {
  it('writes the team columns with the parent key and retired date', () => {
    const rows = teamCsvRows([
      team(),
      team({
        id: 'team-2',
        name: 'Web',
        key_prefix: 'WEB',
        parent_team_id: 'team-1',
        private: true,
        member_count: undefined,
        retired_at: '2026-10-01T12:00:00Z',
      }),
    ]);

    expect(rows).toEqual([
      [
        'Name',
        'Key',
        'Parent team key',
        'Visibility',
        'Members',
        'Created',
        'Retired',
      ],
      ['Engine', 'ENG', '', 'Public', '4', '2026-09-17', ''],
      ['Web', 'WEB', 'ENG', 'Private', '', '2026-09-17', '2026-10-01'],
    ]);
  });

  it('quotes commas and defuses formula names', () => {
    const csv = toCsv(
      teamCsvRows([team({ name: '=HYPERLINK("x")' }), team({ name: 'a,b' })])
    );

    expect(csv).toContain('"\'=HYPERLINK(""x"")"');
    expect(csv).toContain('"a,b"');
  });
});

describe('apiKeyCsvRows', () => {
  it('writes the key columns with the creator display name', () => {
    expect(apiKeyCsvRows([minted], [member()])).toEqual([
      ['Label', 'Created by', 'Scopes', 'Created', 'Last used', 'Expires'],
      [
        'Shell',
        'Ada Lovelace',
        'issues:read; teams:read',
        '2026-09-18',
        '',
        '2026-12-01',
      ],
    ]);
  });

  it('falls back to the handle and never to an email', () => {
    const rows = apiKeyCsvRows(
      [minted, { ...minted, key_id: 'key-2', created_by: 'gone' }],
      [member({ full_name: '', display_name: null })]
    );

    expect(rows[1]?.[1]).toBe('Unknown');
    expect(rows[2]?.[1]).toBe('Unknown');
    expect(apiKeyCsvRows([minted], [member({ full_name: '' })])[1]?.[1]).toBe(
      'ada'
    );
  });

  it('never carries a secret, a prefix or an email', () => {
    const csv = toCsv(apiKeyCsvRows([minted], [member()]));

    expect(csv).not.toContain('wpk_');
    expect(csv).not.toContain('ada@example.com');
  });

  it('defuses a label a spreadsheet would run', () => {
    const csv = toCsv(
      apiKeyCsvRows([{ ...minted, name: '+cmd|calc' }], [member()])
    );

    expect(csv).toContain("'+cmd|calc");
  });
});
