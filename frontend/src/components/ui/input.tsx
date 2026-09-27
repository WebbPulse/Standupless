/**
 * The text controls this application draws: the one line input and the
 * textarea, sharing one border, focus and disabled treatment.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** The classes every text control shares. */
export const CONTROL_CLASS =
  'w-full rounded-sm border border-line-strong bg-bg px-2.5 text-sm text-text placeholder:text-text-faint transition-colors duration-100 hover:border-text-faint focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';

/** Props for Input: the native input props. */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** A one line text input. */
export const Input: React.FC<InputProps> = ({ className = '', ...props }) => (
  <input className={cn(CONTROL_CLASS, 'h-8', className)} {...props} />
);

/** Props for Textarea: the native textarea props. */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

/** A multi line text input. */
export const Textarea: React.FC<TextareaProps> = ({
  className = '',
  ...props
}) => (
  <textarea
    className={cn(
      CONTROL_CLASS,
      'min-h-20 resize-y py-1.5 leading-5',
      className
    )}
    {...props}
  />
);

export default Input;
