/**
 * The mark set beside the product name, for the auth pages and the chrome.
 */

import React from 'react';
import { cn } from '../lib/cn';
import Logo from './Logo';

/** Props for Wordmark: a class for placement and the mark size. */
export interface WordmarkProps {
  className?: string;
  /** The square size of the mark. The name is scaled to match. */
  size?: number;
}

/**
 * The mark and the name as one unit. The name is set in the display stack at a
 * tight tracking, and carries the accessible name for the pair, so the mark is
 * hidden from assistive technology.
 */
export const Wordmark: React.FC<WordmarkProps> = ({
  className = '',
  size = 22,
}) => (
  <span className={cn('inline-flex items-center gap-2', className)}>
    <Logo size={size} title={null} />
    <span
      className="font-semibold tracking-[-0.02em] text-text"
      style={{
        fontFamily: 'var(--brand-font-display)',
        fontSize: `${String(Math.round(size * 0.82))}px`,
      }}
    >
      Standupless
    </span>
  </span>
);

export default Wordmark;
