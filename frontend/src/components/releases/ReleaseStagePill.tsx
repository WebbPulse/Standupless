/**
 * The stage a release has reached, as a small pill whose dot tells the
 * pipeline position at a glance: hollow for a draft that reached no stage,
 * accent for a stage on the way, and success once the final stage is reached.
 * The releases list, its stage filter and a release's own page draw the same
 * dot and pill.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Where a stage sits: no stage yet, on the way, or the pipeline's last. */
export type ReleaseStageTone = 'draft' | 'stage' | 'final';

/** The dot that marks a stage's position in the pipeline. */
export const ReleaseStageDot: React.FC<{ tone: ReleaseStageTone }> = ({
  tone,
}) => (
  <span
    aria-hidden="true"
    className={cn(
      'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
      tone === 'draft'
        ? 'border border-text-faint'
        : tone === 'final'
          ? 'bg-success'
          : 'bg-accent'
    )}
  />
);

/** Props for ReleaseStagePill: the stage reached, if any, and whether it is the last. */
export interface ReleaseStagePillProps {
  /** The stage's name, or null for a release that reached none. */
  name: string | null;
  /** Whether the stage is the pipeline's final one. */
  final: boolean;
  className?: string;
}

/** A pill naming the release's stage, with a dot colored by its position. */
export const ReleaseStagePill: React.FC<ReleaseStagePillProps> = ({
  name,
  final,
  className = '',
}) => (
  <span
    className={cn(
      'inline-flex h-5 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-line px-2 text-2xs font-medium',
      name === null ? 'text-text-muted' : 'text-text',
      className
    )}
  >
    <ReleaseStageDot
      tone={name === null ? 'draft' : final ? 'final' : 'stage'}
    />
    <span className="truncate">{name ?? 'Draft'}</span>
  </span>
);

export default ReleaseStagePill;
