/**
 * The sub-initiative tree as the pages draw it. A parent is held on each
 * child, so the tree is rebuilt from the flat list, and every walk carries a
 * visited set so a cycle reads as a cut branch rather than a loop.
 */

import type { InitiativeRead } from '../types/Api';

/** The most levels one chain of initiatives may run to, matching the API. */
export const MAX_INITIATIVE_DEPTH = 5;

/** One initiative placed in a drawn tree. */
export interface InitiativeTreeRow {
  initiative: InitiativeRead;
  /** How far it is indented, the top of its group being zero. */
  depth: number;
  /** How many of its sub-initiatives sit in the same group below it. */
  childCount: number;
  /** The parent's name when that parent is drawn in another group. */
  parentName: string | null;
}

/** The initiatives directly below each parent, in the list's own order. */
export const childrenByParent = (
  initiatives: InitiativeRead[]
): Map<string, InitiativeRead[]> => {
  const known = new Set(initiatives.map((row) => row.initiative_id));
  const children = new Map<string, InitiativeRead[]>();
  for (const row of initiatives) {
    const parent = row.parent_initiative_id ?? null;
    if (parent === null || parent === row.initiative_id || !known.has(parent))
      continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(row);
    children.set(parent, siblings);
  }
  return children;
};

/** Every initiative below one, never the initiative itself. */
export const descendantIds = (
  initiatives: InitiativeRead[],
  initiativeId: string
): Set<string> => {
  const children = childrenByParent(initiatives);
  const found = new Set<string>();
  const stack = [initiativeId];
  while (stack.length > 0) {
    const node = stack.pop() ?? '';
    for (const child of children.get(node) ?? []) {
      if (
        child.initiative_id === initiativeId ||
        found.has(child.initiative_id)
      )
        continue;
      found.add(child.initiative_id);
      stack.push(child.initiative_id);
    }
  }
  return found;
};

/** How many levels an initiative's subtree spans, itself counted as one. */
export const subtreeHeight = (
  initiatives: InitiativeRead[],
  initiativeId: string
): number => {
  const children = childrenByParent(initiatives);
  const seen = new Set([initiativeId]);
  let frontier = [initiativeId];
  let levels = 0;
  while (frontier.length > 0) {
    levels += 1;
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of children.get(node) ?? []) {
        if (seen.has(child.initiative_id)) continue;
        seen.add(child.initiative_id);
        next.push(child.initiative_id);
      }
    }
    frontier = next;
  }
  return levels;
};

/**
 * The initiatives that may become a parent of one: not itself, not one below
 * it, and not so deep that its subtree would run past the cap.
 */
export const parentCandidates = (
  initiatives: InitiativeRead[],
  initiative: InitiativeRead
): InitiativeRead[] => {
  const below = descendantIds(initiatives, initiative.initiative_id);
  const height = subtreeHeight(initiatives, initiative.initiative_id);
  return initiatives.filter(
    (row) =>
      row.initiative_id !== initiative.initiative_id &&
      !below.has(row.initiative_id) &&
      (row.ancestors?.length ?? 0) + 1 + height <= MAX_INITIATIVE_DEPTH
  );
};

/**
 * One status group's initiatives as indented rows. A sub-initiative sits
 * under its parent when both are in the group; otherwise it opens a branch of
 * its own and names the parent. A collapsed parent hides everything below it.
 */
export const initiativeTreeRows = (
  rows: InitiativeRead[],
  everything: InitiativeRead[],
  collapsed: ReadonlySet<string>
): InitiativeTreeRow[] => {
  const inGroup = new Set(rows.map((row) => row.initiative_id));
  const names = new Map(
    everything.map((row) => [row.initiative_id, row.name] as const)
  );
  const children = childrenByParent(rows);
  const placed = new Set<string>();
  const out: InitiativeTreeRow[] = [];
  const visit = (initiative: InitiativeRead, depth: number): void => {
    if (placed.has(initiative.initiative_id)) return;
    placed.add(initiative.initiative_id);
    const below = (children.get(initiative.initiative_id) ?? []).filter(
      (child) => !placed.has(child.initiative_id)
    );
    const parent = initiative.parent_initiative_id ?? null;
    out.push({
      initiative,
      depth,
      childCount: below.length,
      parentName:
        depth === 0 && parent !== null && !inGroup.has(parent)
          ? (names.get(parent) ?? null)
          : null,
    });
    if (collapsed.has(initiative.initiative_id)) {
      for (const id of descendantIds(rows, initiative.initiative_id))
        placed.add(id);
      return;
    }
    for (const child of below) visit(child, depth + 1);
  };
  for (const row of rows) {
    const parent = row.parent_initiative_id ?? null;
    if (parent === null || !inGroup.has(parent) || parent === row.initiative_id)
      visit(row, 0);
  }
  for (const row of rows) visit(row, 0);
  return out;
};
