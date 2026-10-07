/**
 * Label groups as the pickers, filters and editors see them. A group is a
 * label with `is_group` set that holds the labels naming it in `parent_id`.
 * No issue carries a group, and an issue carries at most one label of each
 * group, so picking a second one swaps rather than adds, as in Linear.
 */

import type { LabelRead } from '../types/Api';

/** Whether a label is a group rather than a label an issue can carry. */
export const isLabelGroup = (label: LabelRead): boolean =>
  label.is_group === true;

/** The group a label sits in, when it is in one listed here. */
export const groupOf = (
  label: LabelRead,
  labels: readonly LabelRead[]
): LabelRead | undefined =>
  label.parent_id === undefined || label.parent_id === null
    ? undefined
    : labels.find(
        (candidate) =>
          candidate.id === label.parent_id && isLabelGroup(candidate)
      );

/** A label's `Group/Label` name, or its bare name outside a group. */
export const labelPath = (
  label: LabelRead,
  labels: readonly LabelRead[]
): string => {
  const group = groupOf(label, labels);
  return group === undefined ? label.name : `${group.name}/${label.name}`;
};

/** The labels an issue can carry, groups left out. */
export const pickableLabels = <T extends LabelRead>(
  labels: readonly T[]
): T[] => labels.filter((label) => !isLabelGroup(label));

/** One heading of a grouped label list, or the ungrouped labels when `group` is undefined. */
export interface LabelSection<T extends LabelRead = LabelRead> {
  group: T | undefined;
  labels: T[];
}

/**
 * The labels laid out under their groups: ungrouped labels first, then each
 * group in the order given with its labels. A group with no labels still gets
 * its section, so an editor can show it empty.
 */
export const labelSections = <T extends LabelRead>(
  labels: readonly T[]
): LabelSection<T>[] => {
  const groups = labels.filter(isLabelGroup);
  const groupIds = new Set(groups.map((group) => group.id));
  const loose = labels.filter(
    (label) =>
      !isLabelGroup(label) &&
      (label.parent_id === undefined ||
        label.parent_id === null ||
        !groupIds.has(label.parent_id))
  );
  return [
    { group: undefined, labels: loose },
    ...groups.map((group) => ({
      group,
      labels: labels.filter(
        (label) => !isLabelGroup(label) && label.parent_id === group.id
      ),
    })),
  ];
};

/**
 * The ids an issue keeps once `labelId` is picked: the label added and any
 * other label of its group dropped, or the label dropped when already held.
 */
export const toggleLabel = (
  labels: readonly LabelRead[],
  value: readonly string[],
  labelId: string
): string[] => {
  if (value.includes(labelId)) return value.filter((id) => id !== labelId);
  const picked = labels.find((label) => label.id === labelId);
  const parent = picked?.parent_id ?? null;
  const kept =
    parent === null
      ? [...value]
      : value.filter(
          (id) => labels.find((label) => label.id === id)?.parent_id !== parent
        );
  return [...kept, labelId];
};

/**
 * The labels an issue already carries that adding `adding` would replace,
 * because they sit in the same group as one of the added labels.
 */
export const replacedSiblings = (
  labels: readonly LabelRead[],
  carried: readonly string[],
  adding: readonly string[]
): string[] => {
  const groups = new Set(
    adding
      .map((id) => labels.find((label) => label.id === id)?.parent_id ?? null)
      .filter((parent): parent is string => parent !== null)
  );
  if (groups.size === 0) return [];
  return carried.filter((id) => {
    if (adding.includes(id)) return false;
    const parent = labels.find((label) => label.id === id)?.parent_id ?? null;
    return parent !== null && groups.has(parent);
  });
};

/** Labels with the name of the group each sits in, for lists that merge labels across teams. */
export const withGroupNames = <T extends LabelRead>(
  labels: readonly T[]
): (T & { group_name?: string })[] =>
  labels.map((label) => {
    const group = groupOf(label, labels);
    return group === undefined ? label : { ...label, group_name: group.name };
  });
