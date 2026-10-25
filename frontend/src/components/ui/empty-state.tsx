/**
 * The one line a list shows when it has nothing in it, with room for the
 * action that fills it: create the first item, with its shortcut shown, or
 * clear the filters that hide everything.
 */

import React from 'react';
import { displayKeys } from '../../hooks/useShortcuts';
import { cn } from '../../lib/cn';
import { Kbd } from './badge';
import Button, { type ButtonVariant } from './button';

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

/** Props for EmptyStateButton: what it reads, what it does and the keys that do the same. */
export interface EmptyStateButtonProps {
  label: string;
  onClick: () => void;
  /** The shortcut that runs the same action, shown beneath as "or press". */
  keys?: string | undefined;
  variant?: ButtonVariant;
}

/** The button an empty state offers, with its shortcut hint beneath when it has one. */
export const EmptyStateButton: React.FC<EmptyStateButtonProps> = ({
  label,
  onClick,
  keys,
  variant = 'primary',
}) => (
  <div className="flex flex-col items-center gap-2">
    <Button variant={variant} size="sm" onClick={onClick}>
      {label}
    </Button>
    {keys !== undefined && (
      <span className="flex items-center gap-1 text-xs text-text-faint pointer-coarse:hidden">
        or press
        {displayKeys(keys)
          .flatMap((token) => token.split(' '))
          .map((cap, index) => (
            <Kbd key={`${cap}-${String(index)}`}>{cap}</Kbd>
          ))}
      </span>
    )}
  </div>
);

export default EmptyState;
