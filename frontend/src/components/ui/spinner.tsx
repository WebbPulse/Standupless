/**
 * The one loading indicator this application draws, used by the route guards
 * and by any page waiting on a first read.
 */

import React from 'react';

/** Props for Spinner: an accessible label for screen readers. */
export interface SpinnerProps {
  label?: string;
}

/** A centred spinner with a screen reader label. */
const Spinner: React.FC<SpinnerProps> = ({ label = 'Loading' }) => (
  <div
    role="status"
    aria-live="polite"
    className="flex items-center justify-center p-8"
  >
    <span className="h-6 w-6 animate-spin rounded-full border-2 border-slate-600 border-t-slate-100" />
    <span className="sr-only">{label}</span>
  </div>
);

export default Spinner;
