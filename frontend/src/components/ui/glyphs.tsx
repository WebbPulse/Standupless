/**
 * The two glyphs an issue row leads with: a status circle drawn by category,
 * and a priority as bars. Both are decorative next to their text, so they are
 * hidden from assistive technology unless a name is passed.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { IssuePriority, StatusCategory } from '../../types/Api';

/** Props for StatusGlyph: the status category and an optional spoken name. */
export interface StatusGlyphProps {
  category: StatusCategory | undefined;
  name?: string;
  className?: string;
}

const CATEGORY_COLOR: Record<StatusCategory, string> = {
  backlog: 'text-text-faint',
  unstarted: 'text-text-muted',
  started: 'text-warning',
  completed: 'text-accent',
  cancelled: 'text-text-faint',
};

/** A 14px circle: dashed for backlog, empty, half, full, or crossed. */
export const StatusGlyph: React.FC<StatusGlyphProps> = ({
  category,
  name,
  className = '',
}) => {
  const tone =
    category === undefined ? 'text-text-faint' : CATEGORY_COLOR[category];
  const labelled =
    name === undefined
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': name };
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('h-3.5 w-3.5 shrink-0', tone, className)}
      {...labelled}
    >
      {category === 'backlog' || category === undefined ? (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      ) : category === 'unstarted' ? (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      ) : category === 'started' ? (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" />
        </>
      ) : category === 'completed' ? (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.2 7.2 6.2 9.2 9.9 5.3"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path
            d="M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
};

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
