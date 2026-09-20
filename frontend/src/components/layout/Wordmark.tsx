/**
 * The product name as it appears in the chrome: a small accent mark and the
 * word, sized to sit in a 28px row.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Wordmark: an optional class for placement. */
export interface WordmarkProps {
  className?: string;
}

/** The mark and the name, as one inline unit. */
export const Wordmark: React.FC<WordmarkProps> = ({ className = '' }) => (
  <span
    className={cn(
      'inline-flex items-center gap-2 text-sm font-semibold',
      className
    )}
  >
    <span
      aria-hidden="true"
      className="inline-flex h-4 w-4 items-center justify-center rounded-xs bg-accent"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-on-accent" />
    </span>
    Standupless
  </span>
);

export default Wordmark;
