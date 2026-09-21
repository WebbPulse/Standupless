/**
 * The primary action on an auth page. It is the shared Button with the brand
 * accent painted over the app accent, so the one action a signed out page is
 * for carries the brand colour without changing the button everywhere else.
 */

import React from 'react';
import Button, { type ButtonProps } from '../../components/ui/button';
import { cn } from '../../lib/cn';

/** A full width primary button in the brand accent. */
export const AuthSubmitButton: React.FC<ButtonProps> = ({
  className = '',
  ...props
}) => (
  <Button
    variant="primary"
    className={cn(
      'w-full bg-[var(--brand-accent)] text-[var(--brand-accent-foreground)] hover:brightness-110 focus-visible:outline-[var(--brand-accent-ring)]',
      className
    )}
    {...props}
  />
);

export default AuthSubmitButton;
