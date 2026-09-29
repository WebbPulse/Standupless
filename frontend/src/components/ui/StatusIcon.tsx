/**
 * The one status glyph the app draws, everywhere a status shows: rows, board
 * columns, pickers, filters, the timeline and team settings. Every variant is
 * drawn here on a 14px grid, so a status reads the same in each place.
 */

import React from 'react';
import { cn } from '../../lib/cn';
import {
  PIE_RADIUS,
  piePath,
  statusLook,
  UNKNOWN_STATUS_LOOK,
  type StatusIconName,
  type StatusLike,
  type StatusLook,
} from '../../lib/statusAppearance';

/**
 * Props for StatusIcon. Pass a status and the statuses it ranks among, or a
 * look already resolved; a missing status draws the unknown glyph.
 */
export interface StatusIconProps {
  status?: StatusLike | undefined;
  statuses?: readonly StatusLike[];
  look?: StatusLook;
  name?: string;
  className?: string;
}

const RING = { cx: 7, cy: 7, r: 5.5, fill: 'none', strokeWidth: 1.5 } as const;

/** A filled disc with a mark knocked out of it in the page background. */
const Knockout: React.FC<{ d: string }> = ({ d }) => (
  <>
    <circle cx="7" cy="7" r="6" fill="currentColor" />
    <path
      d={d}
      fill="none"
      stroke="var(--bg)"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
);

/** A ring with a mark drawn inside it in the status color. */
const Outlined: React.FC<{ d: string }> = ({ d }) => (
  <>
    <circle {...RING} stroke="currentColor" />
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </>
);

const CHECK = 'M4.2 7.2 6.2 9.2 9.9 5.3';
const CROSS = 'M4.8 4.8 9.2 9.2 M9.2 4.8 4.8 9.2';

/** The shapes one variant draws inside the 14px box. */
const Shape: React.FC<{ icon: StatusIconName; fill: number }> = ({
  icon,
  fill,
}) => {
  switch (icon) {
    case 'dashed':
      return <circle {...RING} stroke="currentColor" strokeDasharray="2 2" />;
    case 'dotted':
      return (
        <circle
          {...RING}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray="0.01 2.6"
        />
      );
    case 'question':
      return (
        <>
          <circle {...RING} stroke="currentColor" strokeDasharray="2 2" />
          <path
            d="M5.6 5.6a1.45 1.45 0 1 1 2.1 1.3c-.45.25-.7.55-.7 1.05"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
          <circle cx="7" cy="9.9" r="0.75" fill="currentColor" />
        </>
      );
    case 'circle':
      return <circle {...RING} stroke="currentColor" />;
    case 'circle_dot':
      return (
        <>
          <circle {...RING} stroke="currentColor" />
          <circle cx="7" cy="7" r="1.75" fill="currentColor" />
        </>
      );
    case 'progress':
    case 'quarter':
    case 'half':
    case 'three_quarters':
      return (
        <>
          <circle {...RING} stroke="currentColor" />
          {fill >= 1 ? (
            <circle cx="7" cy="7" r={PIE_RADIUS} fill="currentColor" />
          ) : fill > 0 ? (
            <path d={piePath(fill)} fill="currentColor" />
          ) : null}
        </>
      );
    case 'paused':
      return (
        <>
          <circle {...RING} stroke="currentColor" />
          <path
            d="M5.6 4.9v4.2M8.4 4.9v4.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </>
      );
    case 'blocked':
      return <Outlined d="M4.6 7h4.8" />;
    case 'check':
      return <Knockout d={CHECK} />;
    case 'check_outline':
      return <Outlined d={CHECK} />;
    case 'cross':
      return <Knockout d={CROSS} />;
    case 'cross_outline':
      return <Outlined d={CROSS} />;
    case 'duplicate':
      return (
        <>
          <circle
            cx="5.2"
            cy="7"
            r="4.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <circle cx="8.8" cy="7" r="4.4" fill="currentColor" />
        </>
      );
  }
};

/** A 14px status glyph in the status's own color, icon and fill. */
export const StatusIcon: React.FC<StatusIconProps> = ({
  status,
  statuses,
  look,
  name,
  className = '',
}) => {
  const resolved =
    look ??
    (status === undefined ? UNKNOWN_STATUS_LOOK : statusLook(status, statuses));
  const labelled =
    name === undefined
      ? { 'aria-hidden': true }
      : { role: 'img', 'aria-label': name };
  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('h-3.5 w-3.5 shrink-0', className)}
      style={{ color: resolved.color }}
      data-status-icon={resolved.icon}
      {...labelled}
    >
      <Shape icon={resolved.icon} fill={resolved.fill} />
    </svg>
  );
};

export default StatusIcon;
