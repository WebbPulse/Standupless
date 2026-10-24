/**
 * What a form template's answers will put on the issue, worked out the way the
 * server does it so the create dialog's chips show the result before submit.
 *
 * A chosen select option's label leads the issue's labels and wins over a
 * hand-picked label of the same group, and the last chosen option with a
 * priority replaces the issue's. The hand-picked labels and priority stay in
 * the draft untouched, so changing an answer only moves the preview.
 */

import type { FormFieldRead, IssuePriority, LabelRead } from '../types/Api';
import { isLabelGroup } from './labelGroups';

/** The labels and priority a form's chosen options map to. */
export interface FormMapping {
  labelIds: string[];
  priority: IssuePriority | null;
}

/** The labels and the last priority the chosen select options map to. */
export const formMapping = (
  fields: readonly FormFieldRead[],
  answers: Readonly<Record<string, string | boolean>>
): FormMapping => {
  const labelIds: string[] = [];
  let priority: IssuePriority | null = null;
  for (const field of fields) {
    if (field.type !== 'select') continue;
    const answer = answers[field.key];
    if (typeof answer !== 'string') continue;
    const chosen = field.options.find((option) => option.value === answer);
    if (chosen === undefined) continue;
    const labelId = chosen.label_id ?? null;
    if (labelId !== null && !labelIds.includes(labelId)) labelIds.push(labelId);
    if (chosen.priority !== null && chosen.priority !== undefined) {
      priority = chosen.priority;
    }
  }
  return { labelIds, priority };
};

/**
 * The labels the issue will carry: the mapped ones first, then the
 * hand-picked ones, keeping only labels the team offers and one per group.
 * Until the team's labels load, every id is kept as it stands.
 */
export const previewLabels = (
  labels: readonly LabelRead[],
  mapped: readonly string[],
  picked: readonly string[]
): string[] => {
  const kept: string[] = [];
  const groups = new Set<string>();
  for (const id of [...mapped, ...picked]) {
    if (kept.includes(id)) continue;
    const label = labels.find((row) => row.id === id);
    if (label === undefined) {
      if (labels.length === 0) kept.push(id);
      continue;
    }
    if (isLabelGroup(label)) continue;
    const parent = label.parent_id ?? null;
    if (parent !== null) {
      if (groups.has(parent)) continue;
      groups.add(parent);
    }
    kept.push(id);
  }
  return kept;
};

/** The priority the issue will carry: the mapped one when a chosen option sets it. */
export const previewPriority = (
  mapping: FormMapping,
  picked: IssuePriority
): IssuePriority => mapping.priority ?? picked;

/**
 * The hand-picked labels after the person edits the previewed chips. A mapped
 * label the person did not pick stays out of the hand-picked set, and a
 * hand-picked label the mapping was hiding is kept unless the person has now
 * picked another of its group.
 */
export const pickedAfterEdit = (
  labels: readonly LabelRead[],
  mapping: FormMapping,
  picked: readonly string[],
  shown: readonly string[],
  next: readonly string[]
): string[] => {
  const parentOf = (id: string): string | null =>
    labels.find((row) => row.id === id)?.parent_id ?? null;
  const chosen = next.filter(
    (id) => !mapping.labelIds.includes(id) || picked.includes(id)
  );
  const nextGroups = new Set(
    chosen.map(parentOf).filter((parent): parent is string => parent !== null)
  );
  const hidden = picked.filter((id) => {
    if (shown.includes(id) || chosen.includes(id)) return false;
    const parent = parentOf(id);
    return parent === null || !nextGroups.has(parent);
  });
  return [...chosen, ...hidden];
};
