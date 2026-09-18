/**
 * The one text input this application draws.
 */

import React from 'react';

/** Props for Input: the native input props. */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** A text input with the shared border, focus ring and disabled treatment. */
export const Input: React.FC<InputProps> = ({ className = '', ...props }) => (
  <input
    className={`w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    {...props}
  />
);

export default Input;
