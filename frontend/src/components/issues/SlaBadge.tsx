/**
 * The marker an issue carries while its team's SLA covers it: "Breaches in
 * 2d 4h" in a quiet chip, the same text in amber once it is at risk, and
 * "Breached 3h ago" in red after the deadline. An issue with no SLA draws
 * nothing. The status is recomputed once a minute from the issue's own
 * timestamps, so a list left open does not keep showing a stale state.
 */

import React, { useEffect, useState } from 'react';
import { LuClock, LuFlame } from 'react-icons/lu';
import { cn } from '../../lib/cn';
import { fullTimestamp } from '../../lib/relativeTime';
import { liveSlaStatus, slaLabel, type SlaFields } from '../../lib/sla';
import type { SlaStatus } from '../../types/Api';

/** How often the badge recomputes its status and countdown, in ms. */
const TICK_MS = 60000;

/** Props for SlaBadge: the issue's SLA fields and optional classes. */
export interface SlaBadgeProps {
  issue: SlaFields;
  className?: string;
}

const TONES: Record<Exclude<SlaStatus, 'none'>, string> = {
  on_track: 'border-line text-text-muted',
  at_risk: 'border-warning/40 text-warning',
  breached: 'border-danger/40 text-danger',
};

/** Shows how long an issue has until its SLA breaches, or since it did. */
export const SlaBadge: React.FC<SlaBadgeProps> = ({ issue, className }) => {
  const [now, setNow] = useState(() => new Date());
  const covered =
    issue.sla_status !== 'none' &&
    issue.sla_breaches_at !== null &&
    issue.sla_breaches_at !== undefined;

  useEffect(() => {
    if (!covered) return undefined;
    const timer = setInterval(() => {
      setNow(new Date());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [covered]);

  const status = liveSlaStatus(issue, now);
  const label = slaLabel(issue, now);
  if (status === 'none' || label === null || !covered) return null;
  const deadline = fullTimestamp(issue.sla_breaches_at ?? '');
  const title =
    status === 'breached'
      ? `SLA breached ${deadline}`
      : `SLA breaches ${deadline}`;
  const Icon = status === 'breached' ? LuFlame : LuClock;

  return (
    <span
      title={title}
      data-sla-status={status}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs whitespace-nowrap',
        TONES[status],
        className
      )}
    >
      <Icon aria-hidden="true" className="h-3 w-3" />
      <span>{label}</span>
    </span>
  );
};

export default SlaBadge;
