/**
 * A labelled text input, with room for a hint below it.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import Input, { type InputProps } from './input';
import Label from './label';

/** Props for Field: the input props plus the label text, its id and a hint. */
export interface FieldProps extends InputProps {
  id: string;
  label: string;
  /** A sentence under the control, bound to it for assistive technology. */
  hint?: string;
  /** Hides the label visually while keeping it for assistive technology. */
  hideLabel?: boolean;
}

/** A label bound to an input by id. */
export const Field: React.FC<FieldProps> = ({
  id,
  label,
  hint,
  hideLabel = false,
  className = '',
  ...props
}) => {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  return (
    <div className={cn('space-y-1', className)}>
      <Label htmlFor={id} hidden={hideLabel}>
        {label}
      </Label>
      <Input
        id={id}
        {...(hintId === undefined ? {} : { 'aria-describedby': hintId })}
        {...props}
      />
      {hint !== undefined && (
        <p id={hintId} className="text-xs text-text-faint">
          {hint}
        </p>
      )}
    </div>
  );
};

export default Field;
