/**
 * A checkbox with its text, laid out as one clickable row.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Checkbox: the native input props plus the text beside the box. */
export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
> {
  label: React.ReactNode;
}

/** A checkbox and its label in one row. */
export const Checkbox: React.FC<CheckboxProps> = ({
  label,
  className = '',
  ...props
}) => (
  <label
    className={cn(
      'inline-flex cursor-pointer items-center gap-2 text-sm text-text select-none',
      className
    )}
  >
    <input
      type="checkbox"
      className="h-3.5 w-3.5 shrink-0 rounded-xs border-line-strong"
      {...props}
    />
    {label}
  </label>
);

export default Checkbox;
