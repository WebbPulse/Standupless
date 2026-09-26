/**
 * The velocity section of a team's cycles page: the last closed cycles as a
 * bar chart, the average they delivered, and how the cycle being planned
 * compares with it. Reads in points when the team estimates, with a switch
 * back to issue counts; a team that does not estimate reads in issues only.
 */

import React, { useState } from 'react';
import {
  capacityGuidance,
  velocityMeasure,
  type CapacityGuidance,
  type PlanningMeasure,
} from '../../lib/planningModel';
import type { VelocityRead } from '../../types/Api';
import MeasureToggle from './MeasureToggle';
import VelocityChart from './VelocityChart';

/** Props for VelocityPanel: the team's velocity as the API answered it. */
export interface VelocityPanelProps {
  velocity: VelocityRead;
}

/** A number the way the panel prints it: whole when it is whole. */
const figure = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

/** The capacity sentence for the cycle being planned. */
const guidanceText = (guidance: CapacityGuidance, name: string): string => {
  const unit = guidance.measure === 'points' ? 'points' : 'issues';
  const planned = `${name} has ${figure(guidance.planned)} ${unit} planned against an average of ${figure(guidance.average)}.`;
  if (guidance.delta > 0) {
    return `${planned} That is ${figure(guidance.delta)} over what the team usually completes.`;
  }
  if (guidance.delta < 0) {
    return `${planned} There is room for about ${figure(-guidance.delta)} more.`;
  }
  return `${planned} That matches what the team usually completes.`;
};

/** The team's velocity and capacity guidance. */
export const VelocityPanel: React.FC<VelocityPanelProps> = ({ velocity }) => {
  const natural = velocityMeasure(velocity);
  const [chosen, setChosen] = useState<PlanningMeasure>(natural);
  const measure: PlanningMeasure = natural === 'points' ? chosen : 'issues';
  const average =
    measure === 'points' ? velocity.average_points : velocity.average_issues;
  const guidance = capacityGuidance(velocity, measure);
  const unit = measure === 'points' ? 'points' : 'issues';

  if (velocity.cycles.length === 0) {
    return (
      <section
        aria-labelledby="velocity-heading"
        className="rounded-md border border-line bg-surface p-4"
      >
        <h2 id="velocity-heading" className="text-sm font-medium">
          Velocity
        </h2>
        <p className="mt-1 text-xs text-text-muted">
          Velocity shows once a cycle has closed.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="velocity-heading"
      className="space-y-3 rounded-md border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="velocity-heading" className="text-sm font-medium">
          Velocity
        </h2>
        <span className="text-xs text-text-muted tabular-nums">
          {`Average ${figure(average)} ${unit} over the last ${String(velocity.cycles.length)} ${velocity.cycles.length === 1 ? 'cycle' : 'cycles'}`}
        </span>
        {natural === 'points' && (
          <span className="ml-auto">
            <MeasureToggle
              value={measure}
              onChange={setChosen}
              label="Velocity measure"
            />
          </span>
        )}
      </div>
      <VelocityChart
        cycles={velocity.cycles}
        measure={measure}
        average={average}
      />
      {guidance !== null && velocity.upcoming !== null && (
        <div
          className="space-y-0.5 border-t border-line pt-3"
          data-testid="capacity-guidance"
        >
          <p className="text-xs font-medium">Capacity</p>
          <p className="text-xs text-text-muted tabular-nums">
            {guidanceText(guidance, velocity.upcoming.name)}
          </p>
          {guidance.carriedIn > 0 && (
            <p className="text-xs text-text-faint tabular-nums">
              {`${figure(guidance.carriedIn)} ${unit} of that carried in from the last cycle.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
};

export default VelocityPanel;
