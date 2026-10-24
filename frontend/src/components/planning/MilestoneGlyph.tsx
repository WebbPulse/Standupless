/**
 * A milestone's progress as a small diamond that fills from the bottom as its
 * issues finish, the way Linear marks a milestone. One glyph for every surface
 * a milestone shows on, so a milestone reads the same in a row, a picker and
 * on the timeline.
 */

import React, { useId } from 'react';
import { cn } from '../../lib/cn';
import {
  milestoneProgress,
  type MilestoneProgressSource,
} from '../../lib/planningDisplay';

/** Props for MilestoneGlyph. */
export interface MilestoneGlyphProps {
  milestone: MilestoneProgressSource;
  size?: number;
  className?: string;
  /** Hides the glyph from assistive technology where its host already names the milestone. */
  decorative?: boolean;
  /** A tooltip that replaces the progress sentence, for a host that adds to it. */
  title?: string;
}

const DIAMOND = 'M7 1.5 L12.5 7 L7 12.5 L1.5 7 Z';
const TOP = 1.5;
const HEIGHT = 11;

/** The milestone diamond, outlined when empty, dashed with no issues, part filled while in flight and solid once complete. */
export const MilestoneGlyph: React.FC<MilestoneGlyphProps> = ({
  milestone,
  size = 14,
  className = '',
  decorative = false,
  title,
}) => {
  const clipId = useId();
  const { state, percent, label } = milestoneProgress(milestone);
  const share = percent / 100;
  const tone = state === 'complete' ? 'var(--success)' : 'var(--accent)';
  return (
    <span
      {...(decorative
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label })}
      title={title ?? label}
      data-milestone-glyph={state}
      data-percent={percent}
      className={cn('inline-flex shrink-0 items-center', className)}
    >
      <svg aria-hidden="true" viewBox="0 0 14 14" width={size} height={size}>
        <defs>
          <clipPath id={clipId}>
            <path d={DIAMOND} />
          </clipPath>
        </defs>
        {state === 'partial' && (
          <rect
            x="0"
            y={TOP + HEIGHT * (1 - share)}
            width="14"
            height={HEIGHT * share}
            fill={tone}
            clipPath={`url(#${clipId})`}
          />
        )}
        <path
          d={DIAMOND}
          fill={state === 'complete' ? tone : 'none'}
          stroke={
            state === 'complete'
              ? tone
              : state === 'partial'
                ? tone
                : 'var(--text-muted)'
          }
          strokeWidth="1.5"
          strokeLinejoin="round"
          {...(state === 'none' ? { strokeDasharray: '2 1.5' } : {})}
        />
        {state === 'complete' && (
          <path
            d="M4.6 7.1 L6.3 8.7 L9.4 5.5"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </span>
  );
};

export default MilestoneGlyph;
