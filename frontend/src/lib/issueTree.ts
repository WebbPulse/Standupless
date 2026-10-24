/**
 * Nests a list section's issues under their parents, the way Linear shows
 * sub-issues in a list: a sub-issue whose parent sits in the same section is
 * drawn indented beneath it, in the section's order, and one whose parent is
 * elsewhere stays a top-level row. Folding a parent hides every row below it.
 */

/** The fields nesting reads off an issue. */
export interface TreeIssue {
  id: string;
  parent_id: string | null;
}

/** One visible row of a nested section. */
export interface TreeRow<T extends TreeIssue> {
  issue: T;
  /** How many parents above it sit in the same section. */
  depth: number;
  /** The parent row's issue id, or null for a top-level row. */
  parentId: string | null;
  /** How many of its sub-issues sit in the same section. */
  childCount: number;
}

/** The folded-set key that folds a parent's sub-issues away. */
export const foldedParentKey = (id: string): string => `subs/${id}`;

/**
 * The rows of a section in tree order, skipping the descendants of a folded
 * parent. With `nest` off every issue is a top-level row in its own order. An
 * issue caught in a parent cycle is drawn at the top level rather than lost.
 */
export const treeRows = <T extends TreeIssue>(
  issues: readonly T[],
  nest: boolean,
  isFolded: (id: string) => boolean
): TreeRow<T>[] => {
  if (!nest) {
    return issues.map((issue) => ({
      issue,
      depth: 0,
      parentId: null,
      childCount: 0,
    }));
  }
  const present = new Set(issues.map((issue) => issue.id));
  const children = new Map<string, T[]>();
  for (const issue of issues) {
    const parent = issue.parent_id;
    if (parent === null || parent === issue.id || !present.has(parent))
      continue;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [issue]);
    else list.push(issue);
  }
  const placed = new Set<string>();
  const rows: TreeRow<T>[] = [];
  const visit = (
    issue: T,
    depth: number,
    parentId: string | null,
    hidden: boolean
  ): void => {
    if (placed.has(issue.id)) return;
    placed.add(issue.id);
    const kids = children.get(issue.id) ?? [];
    if (!hidden) {
      rows.push({ issue, depth, parentId, childCount: kids.length });
    }
    const hideKids = hidden || isFolded(issue.id);
    for (const kid of kids) visit(kid, depth + 1, issue.id, hideKids);
  };
  for (const issue of issues) {
    const parent = issue.parent_id;
    const isRoot =
      parent === null || parent === issue.id || !present.has(parent);
    if (isRoot) visit(issue, 0, null, false);
  }
  for (const issue of issues) {
    if (!placed.has(issue.id)) visit(issue, 0, null, false);
  }
  return rows;
};

/** How a nested row's tree connector is drawn. */
export interface TreeGuide {
  /** True when no later sibling follows, so the elbow ends the guide. */
  last: boolean;
  /**
   * For each ancestor level from the top, whether that ancestor has a later
   * sibling, so its guide keeps running past this row.
   */
  continues: boolean[];
}

/**
 * The connector for every row, in the order given, read off the rows' depths:
 * a row is the last of its siblings when no row at its depth follows before
 * the tree climbs above it.
 */
export const treeGuides = (rows: readonly { depth: number }[]): TreeGuide[] => {
  const seen: boolean[] = [];
  const guides: TreeGuide[] = new Array<TreeGuide>(rows.length);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const depth = rows[index]?.depth ?? 0;
    const continues: boolean[] = [];
    for (let level = 1; level < depth; level += 1) {
      continues.push(seen[level] === true);
    }
    guides[index] = { last: seen[depth] !== true, continues };
    seen[depth] = true;
    seen.length = depth + 1;
  }
  return guides;
};

/** The parent a sub-issue names on its row or card. */
export interface ParentRef {
  id: string;
  key: string;
  title: string;
  /** The parent's own sub-issue progress, when the parent is loaded. */
  progress?: { total: number; completed: number };
}

/** The fields a parent reference reads off an issue. */
export interface ParentedIssue {
  parent_id: string | null;
  parent_key?: string | null;
  parent_title?: string | null;
}

/**
 * The parent an issue names: the loaded parent row when there is one, which is
 * fresher and carries its progress, or else the key and title the list route
 * attached. Undefined for a top-level issue or a parent nothing names.
 */
export const parentRefOf = (
  issue: ParentedIssue,
  loaded?: ReadonlyMap<
    string,
    {
      id: string;
      key: string;
      title: string;
      progress: { total: number; completed: number };
    }
  >
): ParentRef | undefined => {
  const parentId = issue.parent_id;
  if (parentId === null) return undefined;
  const row = loaded?.get(parentId);
  if (row !== undefined) {
    return {
      id: row.id,
      key: row.key,
      title: row.title,
      progress: row.progress,
    };
  }
  const key = issue.parent_key ?? null;
  if (key === null) return undefined;
  return { id: parentId, key, title: issue.parent_title ?? '' };
};
