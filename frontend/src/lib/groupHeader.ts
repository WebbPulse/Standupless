/**
 * The figure a group header reads beside its name: how many issues the group
 * holds, or the sum of their estimates. Each issue is weighed on the scale of
 * the team that holds it, so a view spanning teams adds every team's points
 * the way that team counts them.
 */

import type { ViewGroupHeader } from '../api/views';
import type { EstimateScale, IssueRead } from '../types/Api';
import { estimatePoints } from './issueView';

/** How the teams of a view weigh their issues' estimates. */
export interface EstimateWeights {
  /** The estimate scale of a team, `off` where it does not estimate. */
  scaleFor: (teamId: string) => EstimateScale;
  /** Whether a team counts an unestimated issue as one point. Unset counts none. */
  countsUnestimated?: ((teamId: string) => boolean) | undefined;
}

/**
 * The points one issue adds to a group's total: nothing on a team with
 * estimates off, one or nothing for an unestimated issue as its team counts
 * them, and its estimate's points otherwise.
 */
export const estimateWeight = (
  issue: Pick<IssueRead, 'estimate' | 'team_id'>,
  weights: EstimateWeights
): number => {
  if (weights.scaleFor(issue.team_id) === 'off') return 0;
  const estimate = issue.estimate;
  if (estimate === null || estimate.trim() === '') {
    return weights.countsUnestimated?.(issue.team_id) === true ? 1 : 0;
  }
  return estimatePoints(estimate);
};

/** The sum of a group's estimates, each issue on its own team's scale. */
export const totalEstimate = (
  issues: readonly Pick<IssueRead, 'estimate' | 'team_id'>[],
  weights: EstimateWeights
): number =>
  issues.reduce((sum, issue) => sum + estimateWeight(issue, weights), 0);

/** How a total estimate reads in a header, such as `12 pts` or `1 pt`. */
export const pointsLabel = (points: number): string =>
  `${points} ${points === 1 ? 'pt' : 'pts'}`;

/** The figure a group header reads for its issues under the chosen header. */
export const groupFigure = (
  issues: readonly Pick<IssueRead, 'estimate' | 'team_id'>[],
  header: ViewGroupHeader,
  weights: EstimateWeights
): string =>
  header === 'estimate'
    ? pointsLabel(totalEstimate(issues, weights))
    : String(issues.length);
