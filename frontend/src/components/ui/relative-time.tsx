/**
 * A timestamp as a feed shows it: the short distance from now, with the full
 * date and time in a tooltip and on the `time` element for assistive
 * technology. It re-renders once a minute so "just now" does not stay put.
 */

import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { fullTimestamp, relativeTime } from '../../lib/relativeTime';
import Tooltip from './tooltip';

/** How often the distance is recomputed, in ms. */
const TICK_MS = 60000;

/** Props for RelativeTime: the ISO timestamp and optional classes. */
export interface RelativeTimeProps {
  value: string;
  className?: string;
}

/** Renders "2h ago" with the full timestamp on hover. */
export const RelativeTime: React.FC<RelativeTimeProps> = ({
  value,
  className = '',
}) => {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const full = fullTimestamp(value);

  return (
    <Tooltip text={full} side="top">
      <time
        dateTime={value}
        aria-label={full}
        className={cn('text-xs whitespace-nowrap text-text-faint', className)}
      >
        {relativeTime(value, now)}
      </time>
    </Tooltip>
  );
};

export default RelativeTime;
