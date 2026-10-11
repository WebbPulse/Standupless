/**
 * What an issue template fills in the new issue dialog. The dialog prefills
 * its own fields rather than sending the template id, so everything stays
 * editable and a field the person clears stays cleared.
 *
 * A template is applied leniently, as the server applies one: a status,
 * label or assignee the team no longer offers is dropped rather than refused,
 * so an old template still opens. A list that has not loaded yet is not used
 * to judge, since the server checks whatever is sent.
 */

import type { Assignable } from './issuePeople';
import type {
  IssuePriority,
  LabelRead,
  StatusRead,
  TemplateRead,
  WorkflowScope,
} from '../types/Api';

/** The issue fields one template fills, each absent when it fills nothing. */
export interface TemplatePrefill {
  title?: string;
  body?: string;
  statusId?: string;
  priority?: IssuePriority;
  assigneeId?: string;
  labelIds?: string[];
  estimate?: string;
  projectId?: string;
  projectMilestoneId?: string;
  cycleId?: string;
}

/** The team lists a template's ids are checked against. */
export interface TemplateLists {
  statuses: readonly StatusRead[];
  labels: readonly LabelRead[];
  people: readonly Assignable[];
}

/** Whether an id is offered, judged only once its list has loaded. */
const offered = (id: string, ids: readonly string[]): boolean =>
  ids.length === 0 || ids.includes(id);

/** The fields a template fills for one team, stale ids dropped. */
export const templatePrefill = (
  template: TemplateRead,
  lists: TemplateLists
): TemplatePrefill => {
  const statusIds = lists.statuses.map((status) => status.id);
  const labelIds = lists.labels.map((label) => label.id);
  const people = lists.people.map((person) => person.user_id);
  const labels = template.label_ids.filter((id) => offered(id, labelIds));
  const prefill: TemplatePrefill = {};
  if (template.title !== null) prefill.title = template.title;
  if (template.body !== null) prefill.body = template.body;
  if (template.status_id !== null && offered(template.status_id, statusIds)) {
    prefill.statusId = template.status_id;
  }
  if (template.priority !== null) prefill.priority = template.priority;
  if (template.assignee_id !== null && offered(template.assignee_id, people)) {
    prefill.assigneeId = template.assignee_id;
  }
  if (labels.length > 0) prefill.labelIds = labels;
  if (template.estimate !== null) prefill.estimate = template.estimate;
  if (template.project_id !== null) {
    prefill.projectId = template.project_id;
    if (template.project_milestone_id !== null) {
      prefill.projectMilestoneId = template.project_milestone_id;
    }
  }
  if (template.cycle_id !== null) prefill.cycleId = template.cycle_id;
  return prefill;
};

/** Where a template comes from, as the picker groups it. */
export const TEMPLATE_GROUPS: Record<WorkflowScope, string> = {
  team: 'Team',
  parent: 'Parent team',
  workspace: 'Workspace',
};
