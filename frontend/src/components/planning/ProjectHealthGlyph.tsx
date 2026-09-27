/**
 * A project's health as a 14px glyph: a green ring when on track, amber when
 * at risk, red when off track, and a faint dashed ring before anyone has
 * judged it.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { ProjectHealth } from '../../types/Api';

/** Props for ProjectHealthGlyph: the health and an optional spoken name. */
export interface ProjectHealthGlyphProps {
  health: ProjectHealth | null;
  name?: string;
  className?: string;
}

const TONE: Record<ProjectHealth, string> = {
  on_track: 'text-success',
  at_risk: 'text-warning',
  off_track: 'text-danger',
};

/** One project health drawn as a glyph. */
export const ProjectHealthGlyph: React.FC<ProjectHealthGlyphProps> = ({
  health,
  name,
  className = '',
}) => {
  const labelled =
    name === undefined
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': name };
  return (
    <svg
      viewBox="0 0 14 14"
      data-health={health ?? 'none'}
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        health === null ? 'text-text-faint' : TONE[health],
        className
      )}
      {...labelled}
    >
      {health === null ? (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 1.6"
        />
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        </>
      )}
    </svg>
  );
};

export default ProjectHealthGlyph;
