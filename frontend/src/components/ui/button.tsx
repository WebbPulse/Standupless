/**
 * The one button this application draws, in a primary and a secondary variant.
 */

import React from 'react';

/** Props for Button: the native button props plus a variant. */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary';
}

const VARIANTS: Record<'primary' | 'secondary', string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-500',
  secondary:
    'border border-slate-600 bg-slate-800 text-slate-100 hover:bg-slate-700',
};

/** A button with the shared sizing, focus ring and disabled treatment. */
export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  className = '',
  type = 'button',
  ...props
}) => (
  <button
    type={type}
    className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    {...props}
  />
);

export default Button;
