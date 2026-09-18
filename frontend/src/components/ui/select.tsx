/**
 * The one dropdown this application draws, matching the text input's border and
 * focus treatment, plus the labelled row that wraps it.
 */

import React from 'react';

/** Props for Select: the native select props. */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** A dropdown with the shared border, focus ring and disabled treatment. */
export const Select: React.FC<SelectProps> = ({ className = '', ...props }) => (
  <select
    className={`w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    {...props}
  />
);

/** Props for SelectField: the select props plus the label text and its id. */
export interface SelectFieldProps extends SelectProps {
  id: string;
  label: string;
}

/** A label bound to a dropdown by id. */
export const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  ...props
}) => (
  <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-medium text-slate-200">
      {label}
    </label>
    <Select id={id} {...props} />
  </div>
);

export default Select;
