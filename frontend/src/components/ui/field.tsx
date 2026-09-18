/**
 * A labelled text input, which is the only form row the auth pages need.
 */

import React from 'react';
import Input, { type InputProps } from './input';

/** Props for Field: the input props plus the label text and its id. */
export interface FieldProps extends InputProps {
  id: string;
  label: string;
}

/** A label bound to an input by id. */
export const Field: React.FC<FieldProps> = ({ id, label, ...props }) => (
  <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-slate-200">
      {label}
    </label>
    <Input id={id} {...props} />
  </div>
);

export default Field;
