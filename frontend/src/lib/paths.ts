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
 * One project. Projects are workspace level, so the id alone opens one; a
 * team's key prefix may still ride along in the query to keep the sidebar on
 * the team the reader came from.
 */
export const projectPath = (
  slug: string,
  projectId: string,
  teamKeyPrefix?: string
): string =>
  `${projectsPath(slug)}/${projectId}${
    teamKeyPrefix === undefined || teamKeyPrefix === ''
      ? ''
      : `?team=${encodeURIComponent(teamKeyPrefix)}`
  }`;

/** One cycle of a team. */
export const cyclePath = (
  slug: string,
  keyPrefix: string,
  cycleId: string
): string =>
  `${teamCyclesPath(slug, keyPrefix)}/${encodeURIComponent(cycleId)}`;

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

/** One saved view, run as an issue list. */
export const viewPath = (slug: string, viewId: string): string =>
  `${viewsPath(slug)}/${encodeURIComponent(viewId)}`;

/** The projects list filtered to one team. */
export const teamProjectsPath = (slug: string, keyPrefix: string): string =>
  `${projectsPath(slug)}?team=${encodeURIComponent(keyPrefix)}`;

/** The workspace settings page that lists every team. */
export const settingsTeamsPath = (slug: string): string =>
  `${settingsPath(slug)}/teams`;

/** The caller's own API keys, the settings page every role may open. */
export const apiKeysPath = (slug: string): string =>
  `${settingsPath(slug)}/api-keys`;

/**
 * The key prefix of the team the current route is inside, or null. A team page
 * names it in the path, an issue page in the issue key, and the projects list
 * in its `team` query. The shell reads this rather than route params because
 * it sits above the route that declares them.
 */
export const routeTeamPrefix = (
  pathname: string,
  search = ''
): string | null => {
  const team = /^\/w\/[^/]+\/team\/([^/]+)/.exec(pathname);
  if (team?.[1] !== undefined) return decodeURIComponent(team[1]);
  const issue = /^\/w\/[^/]+\/issues\/([A-Za-z][A-Za-z0-9]*)-\d+/.exec(
    pathname
  );
  if (issue?.[1] !== undefined) return issue[1].toUpperCase();
  if (/^\/w\/[^/]+\/projects(\/|$)/.test(pathname)) {
    return new URLSearchParams(search).get('team');
  }
  return null;
};

/** The issue key the current route shows, or null off an issue page. */
export const routeIssueKey = (pathname: string): string | null => {
  const match = /^\/w\/[^/]+\/issues\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(
    pathname
  );
  return match?.[1] === undefined ? null : match[1].toUpperCase();
};
