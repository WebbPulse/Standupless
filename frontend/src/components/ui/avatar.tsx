/**
 * A person, workspace or team as a small circle of initials, tinted from their
 * name so the same one is always the same colour, or as their uploaded image
 * when one is set. An image that fails to load falls back to the initials.
 */

import React, { useState } from 'react';
import { cn } from '../../lib/cn';

/** Props for Avatar: the name to abbreviate, an optional image and the size. */
export interface AvatarProps {
  name: string;
  /** The uploaded image to show instead of the initials, when one is set. */
  src?: string | null | undefined;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** A circle for a person, a rounded square for a workspace or a team. */
  shape?: 'circle' | 'square';
  className?: string;
}

const HUES = [172, 200, 230, 262, 300, 340, 20, 45];

const SIZES: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'h-4 w-4 text-[8px]',
  sm: 'h-5 w-5 text-[9px]',
  md: 'h-7 w-7 text-2xs',
  lg: 'h-12 w-12 text-sm',
};

const SQUARE_ROUNDING: Record<NonNullable<AvatarProps['size']>, string> = {
  xs: 'rounded-xs',
  sm: 'rounded-xs',
  md: 'rounded-sm',
  lg: 'rounded-md',
};

/** The corner rounding for a shape at a size. */
const rounding = (
  shape: NonNullable<AvatarProps['shape']>,
  size: NonNullable<AvatarProps['size']>
): string => (shape === 'square' ? SQUARE_ROUNDING[size] : 'rounded-full');

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

/** The uploaded image, reporting a failed load so the initials take over. */
const AvatarImage: React.FC<{
  src: string;
  className: string;
  onFail: () => void;
}> = ({ src, className, onFail }) => (
  <img
    src={src}
    alt=""
    aria-hidden="true"
    loading="lazy"
    decoding="async"
    draggable={false}
    onError={onFail}
    className={cn('inline-block shrink-0 object-cover select-none', className)}
  />
);

/** The image when one is set and loads, otherwise a circle of initials with a stable hue. */
export const Avatar: React.FC<AvatarProps> = ({
  name,
  src,
  size = 'sm',
  shape = 'circle',
  className = '',
}) => {
  const [failed, setFailed] = useState<string | null>(null);
  if (src && failed !== src) {
    return (
      <AvatarImage
        src={src}
        className={cn(SIZES[size], rounding(shape, size), className)}
        onFail={() => {
          setFailed(src);
        }}
      />
    );
  }
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = HUES[hash % HUES.length] ?? 200;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-semibold select-none',
        SIZES[size],
        rounding(shape, size),
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
