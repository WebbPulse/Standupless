/**
 * What a project template fills in the new project dialog. The dialog shows
 * the template's fields so they stay editable, resolving its date offsets
 * from today, and sends the template id so the server fills whatever is left
 * out and adds the template's milestones and issues.
 */

import { isoDate } from './propertyOptions';
import type {
  IssuePriority,
  ProjectBlueprint,
  ProjectIconName,
  ProjectStatus,
  TemplateRead,
} from '../types/Api';

/** The project fields one template fills, each absent when it fills nothing. */
export interface ProjectTemplatePrefill {
  description?: string;
  leadId?: string;
  memberIds?: string[];
  status?: ProjectStatus;
  priority?: IssuePriority;
  icon?: ProjectIconName;
  color?: string;
  startDate?: string;
  targetDate?: string;
}

/** The calendar day a number of days after `today`, as `YYYY-MM-DD`. */
export const offsetDate = (days: number, today = new Date()): string =>
  isoDate(
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + days)
  );

/** The fields a project template fills, its offsets resolved from `today`. */
export const projectTemplatePrefill = (
  template: TemplateRead,
  today = new Date()
): ProjectTemplatePrefill => {
  const blueprint = template.project ?? null;
  const prefill: ProjectTemplatePrefill = {};
  if (blueprint === null) return prefill;
  if (blueprint.description != null && blueprint.description !== '') {
    prefill.description = blueprint.description;
  }
  if (blueprint.lead_id != null) prefill.leadId = blueprint.lead_id;
  if (blueprint.member_ids.length > 0) {
    prefill.memberIds = blueprint.member_ids;
  }
  if (blueprint.status != null) prefill.status = blueprint.status;
  if (blueprint.priority != null) prefill.priority = blueprint.priority;
  if (blueprint.icon != null) prefill.icon = blueprint.icon;
  if (blueprint.color != null) prefill.color = blueprint.color;
  if (blueprint.start_offset_days != null) {
    prefill.startDate = offsetDate(blueprint.start_offset_days, today);
  }
  if (blueprint.target_offset_days != null) {
    prefill.targetDate = offsetDate(blueprint.target_offset_days, today);
  }
  return prefill;
};

/** A count and its noun, singular for one. */
const counted = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * What a project template adds beyond the project itself, as "Adds 3
 * milestones and 8 issues", or null when it adds nothing.
 */
export const projectTemplateHint = (
  blueprint: ProjectBlueprint | null | undefined
): string | null => {
  if (blueprint === null || blueprint === undefined) return null;
  const parts: string[] = [];
  if (blueprint.milestones.length > 0) {
    parts.push(counted(blueprint.milestones.length, 'milestone'));
  }
  if (blueprint.issues.length > 0) {
    parts.push(counted(blueprint.issues.length, 'issue'));
  }
  return parts.length === 0 ? null : `Adds ${parts.join(' and ')}`;
};

/** The first key of `prefix` and a number that `taken` does not use. */
export const nextTemplateKey = (
  prefix: string,
  taken: readonly string[]
): string => {
  const used = new Set(taken);
  let number = 1;
  while (used.has(`${prefix}${String(number)}`)) number += 1;
  return `${prefix}${String(number)}`;
};
