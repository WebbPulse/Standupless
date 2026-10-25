/**
 * The buttons this application draws. Four variants cover every call: primary
 * for the one action a surface is for, secondary for the rest, ghost for
 * toolbar and row actions that should not read as buttons until hovered, and
 * danger for the destructive ones. IconButton is the same control with a
 * required label, so an icon on its own never ships without a name. On a
 * touch screen every size grows to a 44px target. While the app is offline a
 * disabled button with no tip of its own is tipped with why: changes need a
 * connection.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import Tooltip from './tooltip';
import { OFFLINE_WRITE_HINT, useOffline } from '../../hooks/useOffline';

/** The looks a button can take. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** The two heights a button comes in. */
export type ButtonSize = 'sm' | 'md';

/** Props for Button: the native button props plus a variant and a size. */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-on-accent hover:bg-accent-strong active:brightness-90 border border-transparent',
  secondary:
    'border border-line-strong bg-bg text-text hover:bg-raised active:bg-line shadow-[0_1px_0_rgba(0,0,0,0.03)]',
  ghost:
    'border border-transparent text-text-muted hover:bg-raised hover:text-text active:bg-line',
  danger:
    'border border-transparent bg-danger-soft text-danger hover:brightness-95 active:brightness-90 dark:hover:brightness-110 dark:active:brightness-125',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs gap-1.5 pointer-coarse:h-11 pointer-coarse:min-w-11',
  md: 'h-8 px-3 text-sm gap-2 pointer-coarse:h-11 pointer-coarse:min-w-11',
};

/** A button with the shared sizing, focus ring and disabled treatment. */
export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...props
}) => {
  const offline = useOffline();
  const hint =
    offline &&
    props.disabled === true &&
    props.title === undefined &&
    props['aria-label'] === undefined
      ? { title: OFFLINE_WRITE_HINT }
      : {};
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm font-medium whitespace-nowrap transition-colors duration-100 select-none disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...hint}
      {...props}
    />
  );
};

/** Props for IconButton: a button whose only content is an icon. */
export interface IconButtonProps extends Omit<ButtonProps, 'aria-label'> {
  /** The name the button is announced and tipped with. */
  label: string;
}

/** A square icon button that always carries its name. */
export const IconButton: React.FC<IconButtonProps> = ({
  label,
  size = 'md',
  variant = 'ghost',
  className = '',
  ...props
}) => {
  const offline = useOffline();
  const tip =
    offline && props.disabled === true
      ? `${label}: ${OFFLINE_WRITE_HINT.toLowerCase()}`
      : label;
  return (
    <Tooltip text={tip}>
      <Button
        aria-label={label}
        size={size}
        variant={variant}
        className={cn(
          size === 'sm' ? 'w-7 px-0' : 'w-8 px-0',
          'pointer-coarse:w-11',
          className
        )}
        {...props}
      />
    </Tooltip>
  );
};

export default Button;
