/**
 * The primary action on an auth page, in the brand accent.
 *
 * It does not build on a Button variant. Every variant sets its own colour with
 * plain utilities, and Tailwind emits those after the arbitrary-value brand
 * ones, so at equal specificity the app palette would win and the button would
 * come out in the app accent. Repeating the shared sizing and focus treatment
 * here keeps the brand colours the only ones in play.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** A full width submit button carrying the brand accent. */
export const AuthSubmitButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className = '', type = 'button', ...props }) => (
  <button
    type={type}
    className={cn(
      'inline-flex h-8 w-full shrink-0 items-center justify-center gap-2 rounded-sm border border-transparent px-3 text-sm font-medium whitespace-nowrap transition-[filter,opacity] duration-100 select-none hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50',
      'bg-[var(--brand-accent)] text-[var(--brand-accent-foreground)] focus-visible:outline-[var(--brand-accent-ring)]',
      className
    )}
    {...props}
  />
);

export default AuthSubmitButton;
