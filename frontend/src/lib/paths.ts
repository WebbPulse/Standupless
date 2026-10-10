/**
 * Every in-application route, built in one place so a path is spelled once.
 *
 * The nouns here are the product's nouns and the API's nouns, which are the
 * same nouns: a team owns the key prefix, the statuses, the labels, the
 * members and the cycles, and a project is a dated body of work that rolls up
 * its issues. Nothing translates between the two layers.
 */

/**
 * The workspace picker. With a single workspace it forwards straight into
 * that workspace, which is where signing in and the home page send people.
 */
export const WORKSPACES_PATH = '/workspaces';

/**
 * The workspace picker held open even for someone with one workspace, for the
 * places that ask to see the list on purpose.
 */
export const ALL_WORKSPACES_PATH = '/workspaces?all=1';

/**
 * The query parameter that holds the home page open for a signed in visitor,
 * who is otherwise sent on into their workspace.
 */
export const LANDING_PARAM = 'landing';

/** The page that creates a workspace. */
export const NEW_WORKSPACE_PATH = '/workspaces/new';

/** The privacy policy, public to everyone. */
export const PRIVACY_PATH = '/privacy';

/** The terms of service, public to everyone. */
export const TERMS_PATH = '/terms';

/** The plans and their prices, public to everyone. */
export const PRICING_PATH = '/pricing';

/** The cancellation and refund policy, public to everyone. */
export const REFUNDS_PATH = '/refunds';

/** How to reach the person who runs Standupless, public to everyone. */
export const CONTACT_PATH = '/contact';

/** The signed out page a person lands on after deleting their account. */
export const ACCOUNT_DELETED_PATH = '/account-deleted';

/** The base path of one workspace's pages. */
export const workspacePath = (slug: string): string => `/w/${slug}`;

/** A team's issue list, which is the team's home. */
export const teamPath = (slug: string, keyPrefix: string): string =>
  `${workspacePath(slug)}/team/${keyPrefix}`;

/** A team's archive: its archived issues and nothing else. */
export const teamArchivePath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/archive`;

/** A team's triage inbox: issues filed from outside the team, waiting to be worked. */
export const teamTriagePath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/triage`;

/** A team's board. */
export const teamBoardPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/board`;

/** A team's cycles. */
export const teamCyclesPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/cycles`;

/** A team's standup digest, for the date in `?date=` or the next one. */
export const teamStandupPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/standup`;

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

/** One project opened on its Updates tab, where a notification about one lands. */
export const projectUpdatesTabPath = (
  slug: string,
  projectId: string
): string => `${projectPath(slug, projectId)}?tab=updates`;

/** Every initiative in the workspace. */
export const initiativesPath = (slug: string): string =>
  `${workspacePath(slug)}/initiatives`;

/** One initiative, workspace level and reached by its id alone. */
export const initiativePath = (slug: string, initiativeId: string): string =>
  `${initiativesPath(slug)}/${initiativeId}`;

/** One cycle of a team. */
export const cyclePath = (
  slug: string,
  keyPrefix: string,
  cycleId: string
): string =>
  `${teamCyclesPath(slug, keyPrefix)}/${encodeURIComponent(cycleId)}`;

/** A team's releases, newest first. */
export const teamReleasesPath = (slug: string, keyPrefix: string): string =>
  `${teamPath(slug, keyPrefix)}/releases`;

/** One release of a team. */
export const releasePath = (
  slug: string,
  keyPrefix: string,
  releaseId: string
): string =>
  `${teamReleasesPath(slug, keyPrefix)}/${encodeURIComponent(releaseId)}`;

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

/** The page that composes a new view over every team. */
export const newViewPath = (slug: string): string => `${viewsPath(slug)}/new`;

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

/** The workspace Workflow settings page, where the inherited statuses are edited. */
export const workflowSettingsPath = (slug: string): string =>
  `${settingsPath(slug)}/workflow`;

/** The workspace Labels settings page, where the inherited labels are edited. */
export const labelsSettingsPath = (slug: string): string =>
  `${settingsPath(slug)}/labels`;

/** The workspace's share links, where every published link can be revoked. */
export const shareLinksSettingsPath = (slug: string): string =>
  `${settingsPath(slug)}/share-links`;

/** The admin only workspace export page, where JSON bundles are made and downloaded. */
export const exportSettingsPath = (slug: string): string =>
  `${settingsPath(slug)}/export`;

/** The admin only issue import page, where CSV files from other trackers are brought in. */
export const importSettingsPath = (slug: string): string =>
  `${settingsPath(slug)}/import`;

/** The caller's own API keys, the settings page every role may open. */
export const apiKeysPath = (slug: string): string =>
  `${settingsPath(slug)}/api-keys`;

/** The connected apps settings page, where authorized OAuth clients are revoked. */
export const connectedAppsPath = (slug: string): string =>
  `${settingsPath(slug)}/connected-apps`;

/** The settings page with the MCP server address and the CLI install steps. */
export const mcpAndCliPath = (slug: string): string =>
  `${settingsPath(slug)}/mcp-and-cli`;

/** The MCP section of the MCP and CLI settings page. */
export const mcpSetupPath = (slug: string): string =>
  `${mcpAndCliPath(slug)}#mcp`;

/** The CLI section of the MCP and CLI settings page. */
export const cliSetupPath = (slug: string): string =>
  `${mcpAndCliPath(slug)}#cli`;

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

/** The merged OpenAPI document, published as a static file beside the app. */
export const OPENAPI_DOCUMENT_PATH = '/openapi.json';
