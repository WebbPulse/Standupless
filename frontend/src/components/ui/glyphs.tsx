/**
 * The priority glyph an issue row leads with, drawn as bars. It is decorative
 * next to its text, so it is hidden from assistive technology unless a name is
 * passed. The status glyph lives in `StatusIcon`.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { IssuePriority } from '../../types/Api';

/** Props for PriorityGlyph: the priority and an optional spoken name. */
export interface PriorityGlyphProps {
  priority: IssuePriority | undefined;
  name?: string;
  className?: string;
}

const BARS: Record<IssuePriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

/** Three rising bars, filled by priority; urgent is a filled square. */
export const PriorityGlyph: React.FC<PriorityGlyphProps> = ({
  priority,
  name,
  className = '',
}) => {
  const count = priority === undefined ? 0 : BARS[priority];
  const labelled =
    name === undefined
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': name };
  if (count === 4) {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn('h-3.5 w-3.5 shrink-0 text-danger', className)}
        {...labelled}
      >
        <rect x="1" y="1" width="12" height="12" rx="2.5" fill="currentColor" />
        <path
          d="M7 3.8v3.9M7 9.6v.6"
          stroke="var(--bg)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
      {...labelled}
    >
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={1.5 + index * 4}
          y={9 - index * 3}
          width="3"
          height={4 + index * 3}
          rx="0.8"
          fill="currentColor"
          className={index < count ? 'text-text-muted' : 'text-line-strong'}
        />
      ))}
    </svg>
  );
};
