/**
 * What a drop of issues on a sidebar item writes: which issues a project or
 * cycle drop sets and the notice it shows when none, which favorites take a
 * drop at all, what a team move would remap and the question it asks, and
 * who may move issues into a team.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderedIssueRead } from '../api/issues';
import type { TeamRead } from '../types/Api';
import {
  dropTargetKey,
  favoriteDropTarget,
  landPropertyDrop,
  planPropertyDrop,
  planTeamDrop,
  remapSentence,
  remapsAnything,
  takesTeamDrop,
  teamMoveTitle,
  teamRemap,
} from './sidebarIssueDrop';

const showToast = vi.fn<(message: string) => void>();

vi.mock('./toast', () => ({
  showToast: (message: string) => {
    showToast(message);
  },
  showErrorToast: vi.fn(),
}));

/** An issue in `teamId` carrying the given fields. */
const issue = (
  id: string,
  teamId: string,
  fields: Partial<OrderedIssueRead> = {}
): OrderedIssueRead =>
  ({
    id,
    key: `ENG-${id}`,
    team_id: teamId,
    status_id: 'st-1',
    label_ids: [],
    cycle_id: null,
    project_id: null,
    ...fields,
  }) as OrderedIssueRead;

/** A team the caller holds `role` on. */
const team = (id: string, fields: Partial<TeamRead> = {}): TeamRead =>
  ({
    id,
    workspace_id: 'ws-1',
    name: 'Design',
    key_prefix: 'DES',
    role: 'member',
    ...fields,
  }) as TeamRead;

beforeEach(() => {
  showToast.mockReset();
});

describe('planPropertyDrop', () => {
  it('sets the value on the writable issues of a fitting team that lack it', () => {
    const plan = planPropertyDrop(
      {
        issues: [
          issue('1', 'a'),
          issue('2', 'a', { cycle_id: 'c-1' }),
          issue('3', 'b'),
          issue('4', 'a'),
        ],
        canEdit: (row) => row.id !== '4',
      },
      (row) => row.team_id === 'a',
      (row) => row.cycle_id === 'c-1'
    );

    expect(plan.moving.map((row) => row.id)).toEqual(['1']);
    expect(plan).toMatchObject({ locked: 1, unmatched: 1, already: 1 });
  });
});

describe('landPropertyDrop', () => {
  it('writes the change once with a moved notice', () => {
    const update = vi.fn();
    const moving = [issue('1', 'a'), issue('2', 'a')];

    landPropertyDrop(
      { update },
      { moving, locked: 0, unmatched: 0, already: 0 },
      'Cycle 4',
      { cycle_id: 'c-1' }
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      ['1', '2'],
      { cycle_id: 'c-1' },
      { message: 'Moved 2 issues to Cycle 4' }
    );
    expect(showToast).not.toHaveBeenCalled();
  });

  it('says the issues are there already when every one holds the value', () => {
    const update = vi.fn();

    landPropertyDrop(
      { update },
      { moving: [], locked: 0, unmatched: 0, already: 2 },
      'Billing',
      { project_id: 'p-1' }
    );

    expect(update).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Already in Billing.');
  });

  it('says the project is not on their team when no issue fits', () => {
    landPropertyDrop(
      { update: vi.fn() },
      { moving: [], locked: 0, unmatched: 3, already: 0 },
      'Billing',
      { project_id: 'p-1' }
    );

    expect(showToast).toHaveBeenCalledWith(
      'Nothing moved, Billing is not on their team.'
    );
  });

  it('counts the issues the caller cannot edit when nothing moved', () => {
    landPropertyDrop(
      { update: vi.fn() },
      { moving: [], locked: 2, unmatched: 0, already: 0 },
      'Billing',
      { project_id: 'p-1' }
    );

    expect(showToast.mock.calls[0]?.[0]).toMatch(/^Nothing moved\. .*2/);
  });
});

describe('teamRemap', () => {
  it('counts the issues whose status or labels the team lacks', () => {
    const remap = teamRemap(
      [
        issue('1', 'a', { status_id: 'st-1', label_ids: ['l-1'] }),
        issue('2', 'a', { status_id: 'st-9', label_ids: ['l-9'] }),
        issue('3', 'a', { status_id: 'st-9' }),
      ],
      [{ id: 'st-1' }],
      [{ id: 'l-1' }]
    );

    expect(remap).toEqual({ statuses: 2, labels: 1 });
    expect(remapsAnything(remap)).toBe(true);
    expect(remapSentence(remap, 'Design')).toBe(
      '2 issues take the closest status Design has and 1 issue loses labels Design does not have.'
    );
  });

  it('remaps nothing when the team shows every status and label', () => {
    const remap = teamRemap(
      [issue('1', 'a', { label_ids: ['l-1'] })],
      [{ id: 'st-1' }],
      [{ id: 'l-1' }]
    );

    expect(remapsAnything(remap)).toBe(false);
  });
});

describe('planTeamDrop', () => {
  it('moves the writable issues from other teams', () => {
    const plan = planTeamDrop(
      {
        issues: [issue('1', 'a'), issue('2', 'b'), issue('3', 'a')],
        canEdit: (row) => row.id !== '3',
      },
      { id: 'b' }
    );

    expect(plan.moving.map((row) => row.id)).toEqual(['1']);
    expect(plan.locked).toBe(1);
    expect(teamMoveTitle(plan.moving, { name: 'Design' })).toBe(
      'Move ENG-1 to Design?'
    );
  });
});

describe('takesTeamDrop', () => {
  it('takes a drop on a team the caller writes to', () => {
    expect(takesTeamDrop(team('b'), 'member')).toBe(true);
  });

  it('refuses a retired team', () => {
    expect(
      takesTeamDrop(team('b', { retired_at: '2026-10-01T00:00:00Z' }), 'owner')
    ).toBe(false);
  });
});

describe('favoriteDropTarget', () => {
  const teams = [team('b')];

  it('reads a team, project or cycle favorite as a target', () => {
    expect(
      favoriteDropTarget(
        { kind: 'team', target_id: 'b', title: 'Design' },
        teams
      )
    ).toEqual({ kind: 'team', team: teams[0] });
    expect(
      favoriteDropTarget(
        { kind: 'project', target_id: 'p-1', title: 'Billing' },
        teams
      )
    ).toEqual({ kind: 'project', projectId: 'p-1', name: 'Billing' });
    expect(
      favoriteDropTarget(
        {
          kind: 'cycle',
          target_id: 'c-1',
          title: 'Cycle 4',
          team_id: 'b',
        },
        teams
      )
    ).toEqual({ kind: 'cycle', cycleId: 'c-1', teamId: 'b', name: 'Cycle 4' });
  });

  it('takes no drop on a view, a document or a cycle without its team', () => {
    expect(
      favoriteDropTarget(
        { kind: 'view', target_id: 'v-1', title: 'Bugs' },
        teams
      )
    ).toBeNull();
    expect(
      favoriteDropTarget(
        { kind: 'document', target_id: 'd-1', title: 'Spec' },
        teams
      )
    ).toBeNull();
    expect(
      favoriteDropTarget(
        { kind: 'cycle', target_id: 'c-1', title: 'Lost' },
        teams
      )
    ).toBeNull();
  });
});

describe('dropTargetKey', () => {
  it('names each target by its kind and id', () => {
    expect(dropTargetKey({ kind: 'team', team: team('b') })).toBe('team:b');
    expect(
      dropTargetKey({ kind: 'cycle', cycleId: 'c-1', teamId: 'b', name: 'x' })
    ).toBe('cycle:c-1');
  });
});
