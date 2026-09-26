/**
 * A project's status as a 14px glyph, the way an issue's status leads its
 * row: dashed for backlog, an empty ring once planned, a pie filling with
 * progress while in progress, bars when paused, and a filled check or cross
 * once it is finished.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import type { ProjectStatus } from '../../types/Api';

/** Props for ProjectStatusGlyph: the status, its progress and a spoken name. */
export interface ProjectStatusGlyphProps {
  status: ProjectStatus;
  /** How far along an in progress project is, as a whole percent. */
  percent?: number;
  name?: string;
  className?: string;
}

const TONE: Record<ProjectStatus, string> = {
  backlog: 'text-text-faint',
  planned: 'text-text-muted',
  in_progress: 'text-warning',
  paused: 'text-text-muted',
  completed: 'text-accent',
  canceled: 'text-text-faint',
};

/** The circumference of the pie's inner stroke, whose width fills the disc. */
const PIE = 2 * Math.PI * 2.5;

/** One project status drawn as a glyph. */
export const ProjectStatusGlyph: React.FC<ProjectStatusGlyphProps> = ({
  status,
  percent = 50,
  name,
  className = '',
}) => {
  const labelled =
    name === undefined
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': name };
  const filled = Math.max(0.08, Math.min(1, percent / 100));
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('h-3.5 w-3.5 shrink-0', TONE[status], className)}
      {...labelled}
    >
      {status === 'backlog' && (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 1.6"
        />
      )}
      {status === 'planned' && (
        <circle
          cx="7"
          cy="7"
          r="5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      )}
      {status === 'in_progress' && (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle
            cx="7"
            cy="7"
            r="2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="5"
            strokeDasharray={`${String(filled * PIE)} ${String(PIE)}`}
            transform="rotate(-90 7 7)"
          />
        </>
      )}
      {status === 'paused' && (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <rect x="4.9" y="4.5" width="1.4" height="5" fill="currentColor" />
          <rect x="7.7" y="4.5" width="1.4" height="5" fill="currentColor" />
        </>
      )}
      {status === 'completed' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path
            d="M4.4 7.2 6.2 9 9.7 5.3"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {status === 'canceled' && (
        <>
          <circle cx="7" cy="7" r="6.25" fill="currentColor" />
          <path
            d="M5 5 9 9M9 5 5 9"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
};

export default ProjectStatusGlyph;
