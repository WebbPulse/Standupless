/**
 * A two-way switch between reading a chart in issues and in estimate points.
 * Drawn as a pair of pressed buttons rather than a select, because there are
 * only two choices and both should be visible at once. A measure that cannot
 * be read stays visible but disabled, with a tooltip saying why.
 */

import React, { useId } from 'react';
import { cn } from '../../lib/cn';
import type { PlanningMeasure } from '../../lib/planningModel';
import { Tooltip } from '../ui/tooltip';

/** Props for MeasureToggle: the measure shown and how to change it. */
export interface MeasureToggleProps {
  value: PlanningMeasure;
  onChange: (measure: PlanningMeasure) => void;
  /** What the pair is labelled as for assistive technology. */
  label?: string;
  /** Why a measure cannot be chosen, by measure; a named measure is disabled. */
  unavailable?: Partial<Record<PlanningMeasure, string>> | undefined;
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
  unavailable,
}) => {
  const describedBy = useId();
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex rounded-md border border-line p-0.5"
    >
      {OPTIONS.map((option) => {
        const on = option.measure === value;
        const reason = unavailable?.[option.measure];
        const button = (
          <button
            key={option.measure}
            type="button"
            aria-pressed={on}
            aria-disabled={reason === undefined ? undefined : true}
            aria-describedby={
              reason === undefined
                ? undefined
                : `${describedBy}-${option.measure}`
            }
            onClick={() => {
              if (reason !== undefined) return;
              onChange(option.measure);
            }}
            className={cn(
              'h-5 rounded-sm px-2 text-2xs focus-visible:outline-2 focus-visible:outline-accent',
              reason !== undefined
                ? 'cursor-not-allowed text-text-faint opacity-50'
                : on
                  ? 'bg-raised text-text'
                  : 'text-text-faint hover:text-text-muted'
            )}
          >
            {option.label}
          </button>
        );
        if (reason === undefined) return button;
        return (
          <React.Fragment key={option.measure}>
            <Tooltip text={reason}>{button}</Tooltip>
            <span id={`${describedBy}-${option.measure}`} className="sr-only">
              {reason}
            </span>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default MeasureToggle;
