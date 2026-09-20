/**
 * The one line a list shows when it has nothing in it, with room for the
 * action that fills it.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for EmptyState: the sentence, an optional icon and an action. */
export interface EmptyStateProps {
  message: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** A quiet centred message with an optional action beneath it. */
export const EmptyState: React.FC<EmptyStateProps> = ({
  message,
  icon,
  action,
  className = '',
}) => (
  <div
    className={cn(
      'flex flex-col items-center justify-center gap-3 px-4 py-16 text-center',
      className
    )}
  >
    {icon !== undefined && (
      <span
        aria-hidden="true"
        className="text-text-faint [&>svg]:h-6 [&>svg]:w-6"
      >
        {icon}
      </span>
    )}
    <p className="max-w-sm text-sm text-text-muted">{message}</p>
    {action}
  </div>
);

export default EmptyState;
