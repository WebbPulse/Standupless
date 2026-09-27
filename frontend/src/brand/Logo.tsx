/**
 * The Standupless mark.
 *
 * The idea is asynchronous progress: work that keeps moving without the room.
 * Two rounded bars climb left to right like rows of work picked up in sequence,
 * and where the third row would sit the bar is gone, reduced to a single dot
 * that has already arrived at the next step. That missing third bar is the
 * standup that is not held, and the dot is the progress that happened anyway.
 * The three elements sit on one rising diagonal at an even eight unit rhythm,
 * so the shape reads as a staircase rather than a chart, and the dot stays a
 * distinct counterweight down to 16px.
 */

import React from 'react';
import { cn } from '../lib/cn';

/** Props for Logo: the rendered square size, a class, and an accessible name. */
export interface LogoProps {
  /** Width and height in pixels. Defaults to 32. */
  size?: number;
  className?: string;
  /**
   * The name assistive technology announces. Pass null where the mark sits
   * beside the name already, so it is not read twice.
   */
  title?: string | null;
}

/**
 * The mark alone, square. It paints in `currentColor`, defaulting to the brand
 * accent, so a text colour class on the caller makes it single-colour on any
 * background.
 */
export const Logo: React.FC<LogoProps> = ({
  size = 32,
  className = '',
  title = 'Standupless',
}) => (
  <svg
    viewBox="0 0 32 32"
    width={size}
    height={size}
    className={cn('text-[var(--brand-accent)]', className)}
    fill="currentColor"
    {...(title === null
      ? { 'aria-hidden': true as const }
      : { role: 'img' as const })}
  >
    {title !== null && <title>{title}</title>}
    <rect x="4" y="21.5" width="12" height="5" rx="2.5" />
    <rect x="10" y="13.5" width="12" height="5" rx="2.5" />
    <rect x="23" y="5.5" width="5" height="5" rx="2.5" />
  </svg>
);

export default Logo;
