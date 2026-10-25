/**
 * The other names an issue's detail read is held under. A page opened from a
 * link reads `issueKey(workspace, 'ENG-12')`, while a change notice names the
 * issue by id, so each read by key records the id it answered for and a
 * notice can refresh the key text reads of that issue as well as the id read.
 */

const refs = new Map<string, Set<string>>();

/** The most names one issue keeps, enough for every casing a page could use. */
const MAX_REFS_PER_ISSUE = 8;

/** The map key for one issue in one workspace. */
const slot = (workspaceId: string, issueId: string): string =>
  `${workspaceId}\u0000${issueId}`;

/** Records that `ref` was read for `issueId`, ignoring a ref that is the id. */
export const rememberIssueRef = (
  workspaceId: string,
  issueId: string,
  ref: string
): void => {
  if (workspaceId === '' || issueId === '' || ref === '' || ref === issueId) {
    return;
  }
  const key = slot(workspaceId, issueId);
  let held = refs.get(key);
  if (held === undefined) {
    held = new Set();
    refs.set(key, held);
  }
  if (held.has(ref)) return;
  if (held.size >= MAX_REFS_PER_ISSUE) {
    const oldest = held.values().next().value;
    if (oldest !== undefined) held.delete(oldest);
  }
  held.add(ref);
};

/** The key texts an issue was read under, apart from its id. */
export const issueRefs = (workspaceId: string, issueId: string): string[] => [
  ...(refs.get(slot(workspaceId, issueId)) ?? []),
];

/** Forgets every recorded name, for tests and sign out. */
export const clearIssueRefs = (): void => {
  refs.clear();
};
