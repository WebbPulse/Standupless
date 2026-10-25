/**
 * The capacity dial a cycle that has not started carries, as Linear's does:
 * a ring filled to the share of the team's recent velocity the cycle already
 * holds, warning once it holds more than the team usually finishes. The
 * tooltip and the accessible name say the figures, such as "8 of 10 points,
 * based on the last 3 cycles".
 */

import React from 'react';
import { capacityLabel, type CycleCapacity } from '../../lib/planningModel';
import { cn } from '../../lib/cn';
import { Tooltip } from '../ui/tooltip';
import ProgressRing from './ProgressRing';

/** Props for CapacityDial: the cycle's capacity and the ring's size. */
export interface CapacityDialProps {
  capacity: CycleCapacity;
  size?: number;
  className?: string;
}

/** A small ring with its capacity sentence on hover and to assistive technology. */
export const CapacityDial: React.FC<CapacityDialProps> = ({
  capacity,
  size = 14,
  className = '',
}) => {
  const label = capacityLabel(capacity);
  const over = capacity.percent > 100;
  return (
    <Tooltip text={label}>
      <span
        role="img"
        aria-label={`Capacity: ${label}`}
        data-testid="capacity-dial"
        data-over={over ? 'true' : undefined}
        className={cn('inline-flex shrink-0 items-center', className)}
      >
        <ProgressRing
          percent={capacity.percent}
          size={size}
          color={over ? 'var(--warning)' : 'var(--accent)'}
        />
      </span>
    </Tooltip>
  );
};

export default CapacityDial;
