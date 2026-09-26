/**
 * A small ring filled to a percentage, the way a project row shows how far
 * along it is. Decorative: every caller writes the number beside it.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for ProgressRing: the whole percent filled and the ring's size. */
export interface ProgressRingProps {
  percent: number;
  size?: number;
  className?: string;
}

/** A ring with an accent arc for the done share. */
export const ProgressRing: React.FC<ProgressRingProps> = ({
  percent,
  size = 14,
  className = '',
}) => {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const share = Math.max(0, Math.min(100, percent)) / 100;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 14 14"
      width={size}
      height={size}
      className={cn('shrink-0', className)}
    >
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      {share > 0 && (
        <circle
          cx="7"
          cy="7"
          r={radius}
          fill="none"
          stroke={share >= 1 ? 'var(--success)' : 'var(--accent)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${String(share * circumference)} ${String(circumference)}`}
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
};

export default ProgressRing;
