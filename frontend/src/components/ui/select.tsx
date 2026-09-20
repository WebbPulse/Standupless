/**
 * The dropdown this application draws: a native select, so the keyboard,
 * screen readers and phones all get their own picker, dressed to match the
 * text input and given its own chevron. Width classes land on the wrapper so
 * the chevron stays inside the control however wide it is.
 */

import React from 'react';
import { LuChevronDown } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { CONTROL_CLASS } from './input';
import Label from './label';

/** Props for Select: the native select props. */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** A dropdown with the shared border, focus ring and disabled treatment. */
export const Select: React.FC<SelectProps> = ({ className = '', ...props }) => (
  <span className={cn('relative inline-block w-full min-w-0', className)}>
    <select
      className={cn(CONTROL_CLASS, 'h-8 cursor-pointer appearance-none pr-7')}
      {...props}
    />
    <LuChevronDown
      aria-hidden="true"
      className="pointer-events-none absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 text-text-faint"
    />
  </span>
);

/** Props for SelectField: the select props plus the label text and its id. */
export interface SelectFieldProps extends SelectProps {
  id: string;
  label: string;
  /** Hides the label visually while keeping it for assistive technology. */
  hideLabel?: boolean;
}

/** A label bound to a dropdown by id. */
export const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  hideLabel = false,
  className = '',
  ...props
}) => (
  <div className={cn('space-y-1', className)}>
    <Label htmlFor={id} hidden={hideLabel}>
      {label}
    </Label>
    <Select id={id} {...props} />
  </div>
);

export default Select;
