/**
 * How an issue stands against its team's SLA, recomputed on the client from
 * the two timestamps the server sends so a badge moves from on track to at
 * risk to breached between reads, and how that standing reads as a label.
 *
 * The rule mirrors the server: breached once the deadline has passed, at risk
 * once the time left is at most a quarter of the whole window or a day,
 * whichever is shorter, and on track before that.
 */

import type { IssuePriority, IssueRead, SlaStatus } from '../types/Api';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The longest at risk window, however long the SLA is. */
export const AT_RISK_CAP_MS = DAY_MS;

/** The share of the window the at risk stretch takes before the cap. */
export const AT_RISK_SHARE = 0.25;

/** The SLA fields an issue carries. */
export type SlaFields = Pick<
  IssueRead,
  'sla_started_at' | 'sla_breaches_at' | 'sla_status'
>;

/** The SLA statuses in filter menu order, `none` last. */
export const SLA_STATUSES: readonly SlaStatus[] = [
  'on_track',
  'at_risk',
  'breached',
  'none',
];

/** How each SLA status reads in a filter menu. */
export const SLA_STATUS_LABELS: Record<SlaStatus, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  breached: 'Breached',
  none: 'No SLA',
};

const parseTime = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

/**
 * The status an SLA has at `now`. A missing or malformed deadline is no SLA;
 * a missing start leaves the at risk window at its one day cap.
 */
export const slaStatusAt = (
  startedAt: string | null | undefined,
  breachesAt: string | null | undefined,
  now: Date = new Date()
): SlaStatus => {
  const deadline = parseTime(breachesAt);
  if (deadline === null) return 'none';
  const left = deadline - now.getTime();
  if (left <= 0) return 'breached';
  const start = parseTime(startedAt);
  const riskWindow =
    start === null || start >= deadline
      ? AT_RISK_CAP_MS
      : Math.min((deadline - start) * AT_RISK_SHARE, AT_RISK_CAP_MS);
  return left <= riskWindow ? 'at_risk' : 'on_track';
};

/**
 * An issue's live SLA status. The server's `none` wins, since it knows when an
 * issue has left its SLA, such as on completion; otherwise the status is
 * recomputed from the timestamps so it stays current between reads.
 */
export const liveSlaStatus = (
  issue: SlaFields,
  now: Date = new Date()
): SlaStatus =>
  issue.sla_status === 'none'
    ? 'none'
    : slaStatusAt(issue.sla_started_at, issue.sla_breaches_at, now);

/**
 * A span as its two largest units, such as "2d 4h", "5h 12m", "3d" or "45m".
 * A unit that comes out as zero is left off, and anything under a minute
 * reads as "1m".
 */
export const formatSlaDuration = (ms: number): string => {
  const minutes = Math.max(1, Math.floor(Math.abs(ms) / MINUTE_MS));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    return hours > 0
      ? `${String(days)}d ${String(hours)}h`
      : `${String(days)}d`;
  }
  if (hours > 0) {
    return rest > 0
      ? `${String(hours)}h ${String(rest)}m`
      : `${String(hours)}h`;
  }
  return `${String(rest)}m`;
};

/**
 * How an SLA reads on its badge at `now`: "Breaches in 2d 4h" before the
 * deadline and "Breached 3h ago" after it, or null when there is no SLA.
 */
export const slaLabel = (
  issue: SlaFields,
  now: Date = new Date()
): string | null => {
  const status = liveSlaStatus(issue, now);
  const deadline = parseTime(issue.sla_breaches_at);
  if (status === 'none' || deadline === null) return null;
  const left = deadline - now.getTime();
  return status === 'breached'
    ? `Breached ${formatSlaDuration(left)} ago`
    : `Breaches in ${formatSlaDuration(left)}`;
};

/** The SLA choices a team can pick per priority, in hours, null for off. */
export const SLA_HOUR_CHOICES: readonly (number | null)[] = [
  null,
  4,
  8,
  12,
  24,
  48,
  72,
  120,
  168,
  336,
];

/**
 * How a number of SLA hours reads in a select: "Off", "4 hours", "1 day",
 * "2 weeks", falling back to days and hours for a value off the list.
 */
export const slaHoursLabel = (hours: number | null): string => {
  if (hours === null) return 'Off';
  const plural = (count: number, unit: string): string =>
    `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
  if (hours % 168 === 0) return plural(hours / 168, 'week');
  if (hours % 24 === 0) return plural(hours / 24, 'day');
  if (hours < 24) return plural(hours, 'hour');
  const days = plural(Math.floor(hours / 24), 'day');
  return `${days} ${plural(hours % 24, 'hour')}`;
};

/** The priorities a team sets SLAs for, in settings order. */
export const SLA_PRIORITIES: readonly Exclude<IssuePriority, 'none'>[] = [
  'urgent',
  'high',
  'medium',
  'low',
];
