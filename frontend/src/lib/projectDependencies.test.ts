/**
 * The timeline's dependency lines: each runs from the end of the blocker's
 * bar to the start of the bar it holds up, sits on the lanes the way the
 * timeline stacks them, skips a folded group or an undated project, and is
 * late when the waiting project starts before its blocker ends.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectRead } from '../types/Api';
import {
  GROUP_HEADER_HEIGHT,
  LANE_HEIGHT,
  dependencyLines,
  dependencyPath,
} from './projectDependencies';
import type { ProjectGroup } from './projectList';
import { dayNumber } from './timeline';

/** The day number of a calendar date, failing the test on a bad one. */
const day = (value: string): number => {
  const parsed = dayNumber(value);
  if (parsed === null) throw new Error(`bad day ${value}`);
  return parsed;
};

/** A project with the given dates and blockers. */
const project = (
  id: string,
  start: string | null,
  target: string | null,
  blockedBy: string[] = []
): ProjectRead =>
  ({
    project_id: id,
    name: id,
    start_date: start,
    target_date: target,
    status: 'planned',
    blocked_by_project_ids: blockedBy,
  }) as ProjectRead;

const range = { start: day('2026-10-01'), end: day('2026-12-31') };

describe('dependencyLines', () => {
  it('joins the blocker end to the blocked start on their lanes', () => {
    const groups: ProjectGroup[] = [
      {
        key: 'all',
        label: 'All',
        kind: 'none',
        rows: [
          project('a', '2026-10-01', '2026-10-10'),
          project('b', '2026-10-20', '2026-10-30', ['a']),
        ],
      },
    ];

    const [line] = dependencyLines(groups, [], range, 10);

    expect(line).toMatchObject({
      blockerId: 'a',
      blockedId: 'b',
      fromX: 100,
      fromY: LANE_HEIGHT / 2,
      toX: 190,
      toY: LANE_HEIGHT + LANE_HEIGHT / 2,
      late: false,
    });
    expect(line === undefined ? '' : dependencyPath(line)).toMatch(
      /^M 100 20 C /
    );
  });

  it('is late when the waiting project starts before its blocker ends', () => {
    const groups: ProjectGroup[] = [
      {
        key: 'all',
        label: 'All',
        kind: 'none',
        rows: [
          project('a', '2026-10-01', '2026-10-10'),
          project('b', '2026-10-05', '2026-10-30', ['a']),
        ],
      },
    ];

    expect(dependencyLines(groups, [], range, 10)[0]?.late).toBe(true);
  });

  it('counts group headers and skips folded groups and undated projects', () => {
    const groups: ProjectGroup[] = [
      {
        key: 'status:planned',
        label: 'Planned',
        kind: 'status',
        rows: [project('a', '2026-10-01', '2026-10-10')],
      },
      {
        key: 'status:backlog',
        label: 'Backlog',
        kind: 'status',
        rows: [project('hidden', '2026-10-01', '2026-10-02', ['a'])],
      },
      {
        key: 'status:in_progress',
        label: 'In progress',
        kind: 'status',
        rows: [
          project('undated', null, null, ['a']),
          project('b', '2026-10-20', '2026-10-30', ['a']),
        ],
      },
    ];

    const lines = dependencyLines(groups, ['status:backlog'], range, 10);

    expect(lines.map((line) => line.blockedId)).toEqual(['b']);
    expect(lines[0]?.toY).toBe(
      GROUP_HEADER_HEIGHT * 3 + LANE_HEIGHT + LANE_HEIGHT + LANE_HEIGHT / 2
    );
  });
});
