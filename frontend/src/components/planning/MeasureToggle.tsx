/**
 * A two-way switch between reading a chart in issues and in estimate points.
 * Drawn as a pair of pressed buttons rather than a select, because there are
 * only two choices and both should be visible at once.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { PlanningMeasure } from '../../lib/planningModel';

/** Props for MeasureToggle: the measure shown and how to change it. */
export interface MeasureToggleProps {
  value: PlanningMeasure;
  onChange: (measure: PlanningMeasure) => void;
  /** What the pair is labelled as for assistive technology. */
  label?: string;
}

const OPTIONS: { measure: PlanningMeasure; label: string }[] = [
  { measure: 'issues', label: 'Issues' },
  { measure: 'points', label: 'Points' },
];

/** The issues and points switch. */
export const MeasureToggle: React.FC<MeasureToggleProps> = ({
  value,
  onChange,
  label = 'Measure',
}) => (
  <div
    role="group"
    aria-label={label}
    className="inline-flex rounded-md border border-line p-0.5"
  >
    {OPTIONS.map((option) => {
      const on = option.measure === value;
      return (
        <button
          key={option.measure}
          type="button"
          aria-pressed={on}
          onClick={() => {
            onChange(option.measure);
          }}
          className={cn(
            'h-5 rounded-sm px-2 text-2xs focus-visible:outline-2 focus-visible:outline-accent',
            on ? 'bg-raised text-text' : 'text-text-faint hover:text-text-muted'
          )}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);

export default MeasureToggle;
