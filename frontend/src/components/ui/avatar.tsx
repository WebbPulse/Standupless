/**
 * A person as a small circle of initials, tinted from their name so the same
 * person is always the same colour.
 */

import React from 'react';
import { cn } from '../../lib/cn';

/** Props for Avatar: the name to abbreviate and the size. */
export interface AvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md';
  className?: string;
}

const HUES = [172, 200, 230, 262, 300, 340, 20, 45];

const SIZES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-5 w-5 text-[9px]',
  md: 'h-7 w-7 text-2xs',
};

/** The one or two letters that stand for a name. */
const initials = (name: string): string => {
  const parts = name
    .trim()
    .split(/[\s@._-]+/)
    .filter(Boolean);
  const head = parts[0]?.[0] ?? '?';
  const tail = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${head}${tail}`.toUpperCase();
};

/** A circle of initials with a stable hue. */
export const Avatar: React.FC<AvatarProps> = ({
  name,
  size = 'sm',
  className = '',
}) => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = HUES[hash % HUES.length] ?? 200;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
        SIZES[size],
        className
      )}
      style={{
        backgroundColor: `oklch(0.88 0.06 ${hue})`,
        color: `oklch(0.35 0.08 ${hue})`,
      }}
    >
      {initials(name)}
    </span>
  );
};

export default Avatar;
