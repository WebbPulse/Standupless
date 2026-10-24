/**
 * How the projects list fits its columns beside the name. Covers that the
 * name keeps a 16rem minimum once any column sits beside it, that each tier
 * carries only the shown columns that join at or below it, that the record
 * timestamps and people join last, and that every tier's template is set as
 * the custom property the grid class reads.
 */

import { describe, expect, it } from 'vitest';
import { columnList, DEFAULT_PROJECT_COLUMNS } from './projectList';
import {
  COLUMN_TIER_ORDER,
  COLUMN_TIERS,
  NAME_TRACK,
  PROJECT_GRID,
  TIER_BLOCK,
  projectGridTracks,
  showsAt,
  tierTracks,
} from './projectListLayout';

const defaults = columnList(DEFAULT_PROJECT_COLUMNS);

describe('tierTracks', () => {
  it('leaves only the name and progress on the narrowest lists', () => {
    expect(tierTracks(defaults, 'base')).toBe('minmax(0,1fr) 3.5rem');
  });

  it('gives the name a real minimum once columns sit beside it', () => {
    expect(NAME_TRACK).toBe('minmax(16rem,1fr)');
    expect(tierTracks(defaults, 'md')).toBe(
      'minmax(16rem,1fr) 2rem 8.5rem 2rem 4.5rem'
    );
  });

  it('adds health and the target date at lg', () => {
    expect(tierTracks(defaults, 'lg')).toBe(
      'minmax(16rem,1fr) 7rem 2rem 8.5rem 2rem 6rem 4.5rem'
    );
  });

  it('adds the start date and teams at xl', () => {
    expect(tierTracks(defaults, 'xl')).toBe(
      'minmax(16rem,1fr) 7rem 2rem 8.5rem 2rem 6rem 6rem 6rem 4.5rem'
    );
  });

  it('adds the record timestamps only at 2xl', () => {
    const shown = columnList('status,created,updated,completed');
    expect(tierTracks(shown, 'xl')).toBe('minmax(16rem,1fr) 8.5rem');
    expect(tierTracks(shown, '2xl')).toBe(
      'minmax(16rem,1fr) 8.5rem 5.5rem 5.5rem 5.5rem'
    );
  });

  it('leaves out a column that is not shown', () => {
    expect(tierTracks(columnList('progress'), 'xl')).toBe(
      'minmax(16rem,1fr) 4.5rem'
    );
    expect(tierTracks(columnList('summary'), 'md')).toBe('minmax(16rem,1fr)');
  });
});

describe('column tiers', () => {
  it('hides the lower value columns first', () => {
    for (const column of [
      'created',
      'updated',
      'completed',
      'members',
      'teams',
      'start',
    ] as const) {
      expect(showsAt(column, 'lg')).toBe(false);
    }
    for (const column of ['priority', 'status', 'lead', 'progress'] as const) {
      expect(showsAt(column, 'md')).toBe(true);
    }
  });

  it('shows each column from its own tier up', () => {
    expect(COLUMN_TIERS.start).toBe('xl');
    expect(showsAt('start', 'xl')).toBe(true);
    expect(showsAt('start', '2xl')).toBe(true);
    expect(TIER_BLOCK.xl).toBe('hidden @min-[72rem]:block');
  });
});

describe('projectGridTracks', () => {
  it('sets a template for every tier the grid class reads', () => {
    const style = projectGridTracks(defaults) as Record<string, string>;
    for (const tier of COLUMN_TIER_ORDER) {
      expect(style[`--project-columns-${tier}`]).toBe(
        tierTracks(defaults, tier)
      );
      expect(PROJECT_GRID).toContain(`var(--project-columns-${tier})`);
    }
  });
});
