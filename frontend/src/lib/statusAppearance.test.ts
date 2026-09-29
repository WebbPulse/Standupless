/**
 * The status appearance resolver: category defaults for rows that predate the
 * fields, stored choices winning, stale or foreign values falling back, and the
 * started default filling by rank.
 */

import { describe, expect, it } from 'vitest';
import type { StatusRead } from '../types/Api';
import {
  CATEGORY_DEFAULT_COLOR,
  ICONS_BY_CATEGORY,
  STATUS_COLORS,
  STATUS_COLOR_VALUES,
  STATUS_ICONS,
  piePath,
  progressFill,
  statusLook,
} from './statusAppearance';

/** A status in the shape the contract answers with. */
const status = (over: Partial<StatusRead> & { id: string }): StatusRead => ({
  name: over.id,
  category: 'started',
  position: 0,
  ...over,
});

const workflow: StatusRead[] = [
  status({ id: 'todo', category: 'unstarted', position: 0 }),
  status({ id: 'doing', position: 1 }),
  status({ id: 'review', position: 2 }),
  status({ id: 'staging', position: 3 }),
  status({ id: 'done', category: 'completed', position: 4 }),
];

describe('the status palette and icons', () => {
  it('matches the backend enums', () => {
    expect(STATUS_COLORS).toHaveLength(14);
    expect(STATUS_ICONS).toHaveLength(16);
    expect(Object.values(ICONS_BY_CATEGORY).flat().sort()).toEqual(
      [...STATUS_ICONS].sort()
    );
  });
});

describe('statusLook', () => {
  it('draws a row with no color or icon from its category', () => {
    expect(statusLook(status({ id: 'x', category: 'completed' }))).toEqual({
      icon: 'check',
      color: CATEGORY_DEFAULT_COLOR.completed,
      fill: 0,
    });
  });

  it('uses a stored color and icon', () => {
    expect(
      statusLook(
        status({ id: 'x', category: 'started', color: 'blue', icon: 'paused' })
      )
    ).toEqual({ icon: 'paused', color: STATUS_COLOR_VALUES.blue, fill: 0 });
  });

  it('falls back when a value is unknown or belongs to another category', () => {
    const look = statusLook(
      status({ id: 'x', category: 'backlog', color: '#ff0000', icon: 'check' })
    );
    expect(look.icon).toBe('dashed');
    expect(look.color).toBe(CATEGORY_DEFAULT_COLOR.backlog);
  });

  it('gives the fixed pies their own fill', () => {
    expect(statusLook(status({ id: 'x', icon: 'quarter' })).fill).toBe(0.25);
    expect(statusLook(status({ id: 'x', icon: 'three_quarters' })).fill).toBe(
      0.75
    );
  });
});

describe('progressFill', () => {
  it('fills each started status by its rank', () => {
    const fills = ['doing', 'review', 'staging'].map((id) =>
      progressFill(
        workflow.find((row) => row.id === id) ?? status({ id }),
        workflow
      )
    );
    expect(fills).toEqual([0.25, 0.5, 0.75]);
  });

  it('keeps a lone started status half full, as it always was', () => {
    const lone = status({ id: 'doing' });
    expect(progressFill(lone, [lone])).toBe(0.5);
  });

  it('falls back to half when the siblings are unknown', () => {
    expect(progressFill(status({ id: 'elsewhere' }), [])).toBe(0.5);
  });

  it('ranks only among the same team when statuses span teams', () => {
    const mine = { ...status({ id: 'a', position: 5 }), team_id: 't1' };
    const theirs = { ...status({ id: 'b', position: 1 }), team_id: 't2' };
    expect(progressFill(mine, [mine, theirs])).toBe(0.5);
  });
});

describe('piePath', () => {
  it('draws a quarter wedge from twelve o clock to three', () => {
    expect(piePath(0.25)).toBe('M7 7 L7 3.5 A3.5 3.5 0 0 1 10.500 7.000 Z');
  });

  it('takes the large arc past half', () => {
    expect(piePath(0.75)).toContain(' 0 1 1 ');
  });
});
