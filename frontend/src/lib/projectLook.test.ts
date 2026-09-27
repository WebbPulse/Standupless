/** Tests for the project look and health lists. */

import { describe, expect, it } from 'vitest';
import { LuBox, LuRocket } from 'react-icons/lu';
import {
  PROJECT_COLORS,
  PROJECT_HEALTHS,
  PROJECT_ICON_NAMES,
  healthLabel,
  projectGlyph,
} from './projectLook';

describe('projectLook', () => {
  it('offers every icon the API accepts', () => {
    expect(PROJECT_ICON_NAMES).toEqual([
      'box',
      'rocket',
      'target',
      'flag',
      'zap',
      'star',
      'bug',
      'book',
      'code',
      'globe',
      'heart',
      'layers',
      'shield',
      'sparkles',
      'users',
      'wrench',
    ]);
  });

  it('falls back to the box glyph when no icon is picked', () => {
    expect(projectGlyph(null)).toBe(LuBox);
    expect(projectGlyph(undefined)).toBe(LuBox);
    expect(projectGlyph('rocket')).toBe(LuRocket);
  });

  it('offers only colours the API accepts', () => {
    for (const color of PROJECT_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('reads health best first, with no updates for none', () => {
    expect(PROJECT_HEALTHS).toEqual(['on_track', 'at_risk', 'off_track']);
    expect(healthLabel('at_risk')).toBe('At risk');
    expect(healthLabel(null)).toBe('No updates');
  });
});
