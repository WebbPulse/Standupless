/**
 * The group header figure: the count by default, and a total estimate that
 * weighs each issue on its own team's scale, skips teams with estimates off
 * and counts an unestimated issue only where its team says to.
 */

import { describe, expect, it } from 'vitest';
import type { EstimateScale } from '../types/Api';
import {
  estimateWeight,
  groupFigure,
  pointsLabel,
  totalEstimate,
  type EstimateWeights,
} from './groupHeader';

const SCALES: Record<string, EstimateScale> = {
  sizes: 'tshirt',
  points: 'fibonacci',
  off: 'off',
};

const weights: EstimateWeights = {
  scaleFor: (teamId) => SCALES[teamId] ?? 'off',
  countsUnestimated: (teamId) => teamId === 'points',
};

const issue = (team_id: string, estimate: string | null) => ({
  team_id,
  estimate,
});

describe('the group header', () => {
  it('weighs an issue on its own team scale', () => {
    expect(estimateWeight(issue('sizes', 'M'), weights)).toBe(3);
    expect(estimateWeight(issue('points', '5'), weights)).toBe(5);
  });

  it('adds nothing for a team with estimates off', () => {
    expect(estimateWeight(issue('off', '8'), weights)).toBe(0);
    expect(estimateWeight(issue('off', null), weights)).toBe(0);
  });

  it('counts an unestimated issue only where its team counts them', () => {
    expect(estimateWeight(issue('points', null), weights)).toBe(1);
    expect(estimateWeight(issue('points', ' '), weights)).toBe(1);
    expect(estimateWeight(issue('sizes', null), weights)).toBe(0);
    expect(
      estimateWeight(issue('points', null), { scaleFor: weights.scaleFor })
    ).toBe(0);
  });

  it('sums a group that mixes teams', () => {
    const issues = [
      issue('sizes', 'L'),
      issue('points', '3'),
      issue('points', null),
      issue('off', '13'),
    ];
    expect(totalEstimate(issues, weights)).toBe(9);
    expect(groupFigure(issues, 'estimate', weights)).toBe('9 pts');
    expect(groupFigure(issues, 'count', weights)).toBe('4');
  });

  it('reads one point in the singular', () => {
    expect(pointsLabel(1)).toBe('1 pt');
    expect(pointsLabel(0)).toBe('0 pts');
    expect(pointsLabel(12)).toBe('12 pts');
  });
});
