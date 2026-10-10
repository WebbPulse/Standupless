/**
 * The pure shape of the workspace home: how the focus list is grouped, which
 * rows the keyboard walks and in what order, and the one line summary under
 * the greeting. Held apart from the components so the order the page draws and
 * the order j and k walk cannot drift.
 */

import type {
  HomeAttentionItem,
  HomeFocusReason,
  HomeRead,
  IssueRead,
} from '../../../types/Api';

/** The sections of the home, in the order the keyboard visits them. */
export type HomeSectionId =
  'focus' | 'shipped' | 'cycles' | 'projects' | 'pulse' | 'inbox';

/** One row the keyboard can land on, and the section it belongs to. */
export interface HomeNavItem {
  section: HomeSectionId;
  id: string;
}

/** One labelled group of focus rows. */
export interface FocusGroup {
  id: string;
  label: string;
  tone: 'danger' | 'warning' | 'neutral';
  total: number;
  issues: IssueRead[];
}

/** The attention reasons, most urgent first, with the heading each group takes. */
export const REASON_ORDER: HomeFocusReason[] = [
  'overdue',
  'sla_breached',
  'sla_at_risk',
  'due_soon',
  'blocked',
];

/** The heading for a focus group led by this reason. */
export const REASON_LABELS: Record<HomeFocusReason, string> = {
  overdue: 'Overdue',
  sla_breached: 'SLA breached',
  sla_at_risk: 'SLA at risk',
  due_soon: 'Due soon',
  blocked: 'Blocked',
};

const REASON_TONE: Record<HomeFocusReason, FocusGroup['tone']> = {
  overdue: 'danger',
  sla_breached: 'danger',
  sla_at_risk: 'warning',
  due_soon: 'warning',
  blocked: 'neutral',
};

/** The most urgent reason an item needs attention for. */
const leadReason = (item: HomeAttentionItem): HomeFocusReason =>
  REASON_ORDER.find((reason) => item.reasons.includes(reason)) ?? 'blocked';

/**
 * Splits the caller's focus into labelled groups: one per attention reason
 * that has an issue, then in progress, then up next. Each issue sits under the
 * most urgent reason it carries only, so a row never shows twice.
 */
export const focusGroups = (focus: HomeRead['focus']): FocusGroup[] => {
  const groups: FocusGroup[] = [];
  for (const reason of REASON_ORDER) {
    const issues = focus.attention
      .filter((item) => leadReason(item) === reason)
      .map((item) => item.issue);
    if (issues.length > 0) {
      groups.push({
        id: reason,
        label: REASON_LABELS[reason],
        tone: REASON_TONE[reason],
        total: issues.length,
        issues,
      });
    }
  }
  if (focus.in_progress.length > 0) {
    groups.push({
      id: 'in_progress',
      label: 'In progress',
      tone: 'neutral',
      total: focus.in_progress_count,
      issues: focus.in_progress,
    });
  }
  if (focus.up_next.length > 0) {
    groups.push({
      id: 'up_next',
      label: 'Up next',
      tone: 'neutral',
      total: focus.up_next_count,
      issues: focus.up_next,
    });
  }
  return groups;
};

/** Every row the keyboard walks, in the order the page draws them. */
export const navItems = (
  home: HomeRead,
  groups: FocusGroup[]
): HomeNavItem[] => [
  ...groups.flatMap((group) =>
    group.issues.map((issue) => ({ section: 'focus' as const, id: issue.id }))
  ),
  ...home.shipped.items.map((item) => ({
    section: 'shipped' as const,
    id: item.issue.id,
  })),
  ...home.cycles.map((cycle) => ({
    section: 'cycles' as const,
    id: cycle.cycle_id,
  })),
  ...home.projects.map((project) => ({
    section: 'projects' as const,
    id: project.project_id,
  })),
  ...home.pulse.map((item) => ({
    section: 'pulse' as const,
    id: item.update.update_id,
  })),
  ...home.inbox.items.map((item) => ({
    section: 'inbox' as const,
    id: item.notification_id,
  })),
];

/** Where each section's first row sits in the walk, for drawing and for jumps. */
export const sectionStarts = (
  items: HomeNavItem[]
): Map<HomeSectionId, number> => {
  const starts = new Map<HomeSectionId, number>();
  items.forEach((item, index) => {
    if (!starts.has(item.section)) starts.set(item.section, index);
  });
  return starts;
};

/**
 * The first row of the next section after the one holding `from`, or of the
 * previous one when `step` is -1. From nothing highlighted, forward lands on
 * the first row and back on the last section's first row.
 */
export const jumpSection = (
  items: HomeNavItem[],
  from: number,
  step: 1 | -1
): number => {
  const starts = [...sectionStarts(items).values()];
  if (starts.length === 0) return -1;
  if (from < 0)
    return step === 1 ? (starts[0] ?? -1) : (starts[starts.length - 1] ?? -1);
  const current = starts.filter((start) => start <= from).length - 1;
  const target = Math.min(Math.max(current + step, 0), starts.length - 1);
  return starts[target] ?? -1;
};

/** "Good morning" and its siblings, by the hour on the caller's clock. */
export const greetingFor = (hour: number): string =>
  hour < 5
    ? 'Good evening'
    : hour < 12
      ? 'Good morning'
      : hour < 18
        ? 'Good afternoon'
        : 'Good evening';

/** One plain count, with its noun made plural where it needs to be. */
export const countLabel = (
  count: number,
  singular: string,
  plural = `${singular}s`
): string => `${String(count)} ${count === 1 ? singular : plural}`;
