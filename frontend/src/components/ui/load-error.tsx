/**
 * The state a page shows when a read failed: the reason and a way to read
 * again. A failed read never leaves a page empty, and the retry runs the same
 * read rather than reloading the whole app.
 */

import React from 'react';
import Button from './button';

/** Props for LoadError: what failed, and how to try it again. */
export interface LoadErrorProps {
  message: string;
  onRetry: () => void;
}

/** The failure sentence with a Retry button beside it. */
export const LoadError: React.FC<LoadErrorProps> = ({ message, onRetry }) => (
  <div
    role="alert"
    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
  >
    <span>{message}</span>
    <Button size="sm" onClick={onRetry}>
      Retry
    </Button>
  </div>
);

export default LoadError;
