/**
 * Every in-application route, built in one place so a path is spelled once.
 *
 * The nouns here are the product's nouns and the API's nouns, which are the
 * same nouns: a team owns the key prefix, the statuses, the labels, the
 * members and the cycles, and a project is a dated body of work that rolls up
 * its issues. Nothing translates between the two layers.
 */

/** The base path of one workspace's pages. */
export const workspacePath = (slug: string): string => `/w/${slug}`;

/** A team's issue list, which is the team's home. */
export const teamPath = (slug: string, keyPrefix: string): string =>
  `${workspacePath(slug)}/team/${keyPrefix}`;

/** A team's board. */
export const teamBoardPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/board`;

/** A team's cycles. */
export const teamCyclesPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/cycles`;

/** A team's settings: statuses, labels, members, transitions and repositories. */
export const teamSettingsPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/settings`;

/** Every project across the teams the caller can see. */
export const projectsPath = (slug: string): string =>
  `${workspacePath(slug)}/projects`;

/**
 * One project. The owning team's key prefix rides along in the query because
 * the planning table files a project under its team's partition and the API
 * has no route that reads one without being told which team it belongs to, so
 * a link that omits it would not open.
 */
export const projectPath = (
  slug: string,
  projectId: string,
  teamKeyPrefix: string
): string =>
  `${projectsPath(slug)}/${projectId}?team=${encodeURIComponent(teamKeyPrefix)}`;

/** The workspace roadmap. */
export const roadmapPath = (slug: string): string =>
  `${workspacePath(slug)}/roadmap`;

/** The caller's own issues across every team. */
export const myIssuesPath = (slug: string): string =>
  `${workspacePath(slug)}/issues`;

/** One issue, addressed by the key a person can type from memory. */
export const issuePath = (slug: string, issueKey: string): string =>
  `${workspacePath(slug)}/issues/${issueKey}`;

/** The workspace inbox. */
export const inboxPath = (slug: string): string =>
  `${workspacePath(slug)}/inbox`;

/** Workspace search. */
export const searchPath = (slug: string): string =>
  `${workspacePath(slug)}/search`;

/** The saved views page. */
export const viewsPath = (slug: string): string =>
  `${workspacePath(slug)}/views`;

/** Workspace settings. */
export const settingsPath = (slug: string): string =>
  `${workspacePath(slug)}/settings`;
