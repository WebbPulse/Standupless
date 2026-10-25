/**
 * The progress report a project update shows under its text: a baseline of
 * where the project stood for a first update, and afterwards only what moved
 * since the update before it. It is a deterministic diff of the two snapshots
 * the server stored on the update, and reads the same as the plain lines the
 * email and the Slack or Discord message carry.
 *
 * Progress is named only once it moved by more than `PROGRESS_THRESHOLD`
 * points, so a small wobble does not crowd the card.
 */

import type {
  MilestoneSnapshot,
  ProjectUpdateRead,
  ProjectUpdateSnapshot,
} from '../types/Api';
import { planningDateLabel } from './dateResolution';
import { PROJECT_STATUS_LABELS, measureUnit } from './planningDisplay';

/** How many whole percent progress must move by before the report names it. */
export const PROGRESS_THRESHOLD = 2;

/** Resolves a user id to the name the reader knows them by, when it can. */
export type NameOf = (userId: string) => string | undefined;

/** The target date as it reads everywhere else, or null without one. */
const targetOf = (
  snapshot: ProjectUpdateSnapshot,
  today: Date
): string | null =>
  snapshot.target_date
    ? planningDateLabel(
        snapshot.target_date,
        snapshot.target_date_resolution,
        today
      )
    : null;

/** The status's name, or its category's label when no name was recorded. */
const statusOf = (snapshot: ProjectUpdateSnapshot): string | null => {
  if (snapshot.status_name) return snapshot.status_name;
  return snapshot.status ? PROJECT_STATUS_LABELS[snapshot.status] : null;
};

/** The lead as a line names them: the current name first, the recorded one after. */
const leadOf = (snapshot: ProjectUpdateSnapshot, nameOf: NameOf): string =>
  (snapshot.lead_id ? nameOf(snapshot.lead_id) : undefined) ??
  snapshot.lead_name ??
  'a new lead';

/** Whether every piece of a milestone's scope is finished. */
const isComplete = (milestone: MilestoneSnapshot): boolean =>
  milestone.total > 0 && milestone.completed >= milestone.total;

/** `a of b`, the way a milestone's count reads. */
const countOf = (milestone: MilestoneSnapshot): string =>
  `${milestone.completed} of ${milestone.total}`;

/** The current values, for an update with nothing earlier to compare with. */
const baseline = (
  snapshot: ProjectUpdateSnapshot,
  nameOf: NameOf,
  today: Date
): string[] => {
  const unit = measureUnit(snapshot.measure, snapshot.total);
  const lines = [
    `Progress ${snapshot.percent}% (${snapshot.completed} of ${snapshot.total} ${unit})`,
  ];
  const target = targetOf(snapshot, today);
  if (target) lines.push(`Target date ${target}`);
  if (snapshot.lead_id) lines.push(`Lead ${leadOf(snapshot, nameOf)}`);
  const status = statusOf(snapshot);
  if (status) lines.push(`Status ${status}`);
  for (const milestone of snapshot.milestones) {
    if (isComplete(milestone)) {
      lines.push(`Milestone ${milestone.name} completed`);
    } else if (milestone.total > 0) {
      lines.push(`Milestone ${milestone.name} ${countOf(milestone)}`);
    }
  }
  return lines;
};

/** Progress from and to, with the scope change, once it moved by more than the threshold. */
const progressLine = (
  snapshot: ProjectUpdateSnapshot,
  previous: ProjectUpdateSnapshot
): string | null => {
  if (Math.abs(snapshot.percent - previous.percent) <= PROGRESS_THRESHOLD)
    return null;
  const line = `Progress ${previous.percent}% to ${snapshot.percent}%`;
  const unit = measureUnit(snapshot.measure, snapshot.total);
  if (snapshot.total !== previous.total)
    return `${line}, scope ${previous.total} to ${snapshot.total} ${unit}`;
  return `${line} (${snapshot.completed} of ${snapshot.total} ${unit})`;
};

/** How the target date moved, or null when it did not. */
const targetLine = (
  snapshot: ProjectUpdateSnapshot,
  previous: ProjectUpdateSnapshot,
  today: Date
): string | null => {
  const before = targetOf(previous, today);
  const after = targetOf(snapshot, today);
  if (before === after) return null;
  if (before && after) return `Target date moved from ${before} to ${after}`;
  if (after) return `Target date set to ${after}`;
  return `Target date removed, was ${before ?? ''}`;
};

/** The status change, or null when it did not change. */
const statusLine = (
  snapshot: ProjectUpdateSnapshot,
  previous: ProjectUpdateSnapshot
): string | null => {
  if (
    snapshot.status_id === previous.status_id &&
    snapshot.status === previous.status
  )
    return null;
  const before = statusOf(previous);
  const after = statusOf(snapshot);
  if (!after || before === after) return null;
  return before
    ? `Status changed from ${before} to ${after}`
    : `Status set to ${after}`;
};

/** The milestones that completed, moved or are new, in the project's milestone order. */
const milestoneLines = (
  snapshot: ProjectUpdateSnapshot,
  previous: ProjectUpdateSnapshot
): string[] => {
  const earlier = new Map(
    previous.milestones.map((milestone) => [milestone.milestone_id, milestone])
  );
  const lines: string[] = [];
  for (const milestone of snapshot.milestones) {
    const was = earlier.get(milestone.milestone_id);
    if (isComplete(milestone)) {
      if (was === undefined || !isComplete(was))
        lines.push(`Milestone ${milestone.name} completed`);
    } else if (was === undefined) {
      if (milestone.total > 0)
        lines.push(`Milestone ${milestone.name} ${countOf(milestone)}`);
    } else if (
      milestone.completed !== was.completed ||
      milestone.total !== was.total
    ) {
      lines.push(
        `Milestone ${milestone.name} ${countOf(was)} to ${countOf(milestone)}`
      );
    }
  }
  return lines;
};

/** The report as lines: a baseline without `previous`, otherwise only what changed. */
export const reportLines = (
  snapshot: ProjectUpdateSnapshot,
  previous: ProjectUpdateSnapshot | null,
  nameOf: NameOf = () => undefined,
  today = new Date()
): string[] => {
  if (previous === null) return baseline(snapshot, nameOf, today);
  const lines = [
    progressLine(snapshot, previous),
    targetLine(snapshot, previous, today),
  ].filter((line): line is string => line !== null);
  if (snapshot.lead_id !== previous.lead_id) {
    lines.push(
      snapshot.lead_id ? `New lead ${leadOf(snapshot, nameOf)}` : 'Lead removed'
    );
  }
  const status = statusLine(snapshot, previous);
  if (status !== null) lines.push(status);
  lines.push(...milestoneLines(snapshot, previous));
  return lines;
};

/** The report one update shows, empty when it predates snapshots or its author hid it. */
export const updateReport = (
  update: Pick<
    ProjectUpdateRead,
    'snapshot' | 'previous_snapshot' | 'hide_details'
  >,
  nameOf: NameOf = () => undefined,
  today = new Date()
): string[] => {
  if (update.hide_details === true || !update.snapshot) return [];
  return reportLines(
    update.snapshot,
    update.previous_snapshot ?? null,
    nameOf,
    today
  );
};
