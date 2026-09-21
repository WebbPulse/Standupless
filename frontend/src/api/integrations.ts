/**
 * The integrations routes: the GitHub App install flow, the repositories an
 * installation can see, the pull requests linked to an issue, per project
 * transition rules and the workspace's outbound webhook endpoints.
 *
 * The two routes GitHub itself calls are deliberately absent. The callback is a
 * browser redirect and the webhook receiver is called by GitHub, so neither is
 * ever reached from this application.
 */

import apiClient, { isApiErrorWithStatus } from './client';
import { errorCode } from '../lib/errors';
import type {
  GithubInstallationRead,
  GithubIssueLinkRead,
  GithubRepositoryRead,
  InstallUrlRead,
  TransitionCreate,
  TransitionRead,
  TransitionUpdate,
  WebhookEndpointCreate,
  WebhookEndpointRead,
  WebhookEndpointUpdate,
} from '../types/Api';

/** The route the install URL is minted on. */
export const installUrlPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/github/install-url`;

/** The route the installation is read and removed through. */
export const installationPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/github/installation`;

/** The route the installation's repositories are listed on. */
export const repositoriesPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/github/repositories`;

/** The route one repository is pinned to a project through. */
export const repositoryPath = (
  workspaceId: string,
  repositoryId: string
): string => `${repositoriesPath(workspaceId)}/${repositoryId}`;

/** The route one issue's linked pull requests are read from. */
export const issueLinksPath = (workspaceId: string, issueId: string): string =>
  `/workspaces/${workspaceId}/issues/${issueId}/github-links`;

/** The route a project's transition rules are listed and created on. */
export const transitionsPath = (
  workspaceId: string,
  projectId: string
): string => `/workspaces/${workspaceId}/teams/${projectId}/github-transitions`;

/** The route one transition rule is edited and deleted through. */
export const transitionPath = (
  workspaceId: string,
  projectId: string,
  transitionId: string
): string => `${transitionsPath(workspaceId, projectId)}/${transitionId}`;

/** The route webhook endpoints are listed and created on. */
export const webhooksPath = (workspaceId: string): string =>
  `/workspaces/${workspaceId}/webhooks`;

/** The route one endpoint is edited and deleted through. */
export const webhookPath = (workspaceId: string, webhookId: string): string =>
  `${webhooksPath(workspaceId)}/${webhookId}`;

/** The route an endpoint's secret is rotated on. */
export const webhookRotatePath = (
  workspaceId: string,
  webhookId: string
): string => `${webhookPath(workspaceId, webhookId)}/rotate`;

const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/**
 * Mints the URL a workspace admin is sent to in order to install the App. The
 * signed state inside it expires, so it is fetched when the button is shown
 * rather than held.
 */
export const getInstallUrl = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<InstallUrlRead> => {
  const response = await apiClient.get<InstallUrlRead>(
    installUrlPath(workspaceId),
    signalOptions(signal)
  );
  return response.data;
};

/**
 * What reading the installation settled on. A 404 and a 503 NOT_CONFIGURED are
 * both ordinary resting states rather than failures, and telling them apart is
 * what lets the settings page say which one it is and stop asking. Anything
 * else throws, because a settings page must not render "not installed" at a
 * caller who simply cannot look, or at a workspace whose read is timing out.
 */
export type InstallationState =
  | { status: 'installed'; installation: GithubInstallationRead }
  | { status: 'not_installed' }
  | { status: 'not_configured' };

/**
 * Reads the workspace's installation. The 404 the route answers when the App is
 * not installed becomes `not_installed`, and the 503 it answers when the App
 * credentials are absent from the environment becomes `not_configured`. Both
 * are settled answers: re-asking cannot change either until someone acts, which
 * is why the caller stops polling on them instead of retrying every 30 seconds.
 *
 * A 403, or a 404 from being outside the workspace, still throws.
 */
export const readInstallation = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<InstallationState> => {
  try {
    const response = await apiClient.get<GithubInstallationRead>(
      installationPath(workspaceId),
      signalOptions(signal)
    );
    const installation = response.data ?? null;
    return installation === null
      ? { status: 'not_installed' }
      : { status: 'installed', installation };
  } catch (error) {
    if (isApiErrorWithStatus(error) && error.status === 404) {
      return { status: 'not_installed' };
    }
    if (
      isApiErrorWithStatus(error) &&
      error.status === 503 &&
      errorCode(error) === 'NOT_CONFIGURED'
    ) {
      return { status: 'not_configured' };
    }
    throw error;
  }
};

/**
 * Reads the workspace's installation, or null when the App is not installed.
 * Kept as the plain shape for callers that only need the installation itself;
 * `readInstallation` is what the settings page uses, because it needs to tell a
 * missing installation apart from an unconfigured environment.
 */
export const getInstallation = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<GithubInstallationRead | null> => {
  const state = await readInstallation(workspaceId, signal);
  return state.status === 'installed' ? state.installation : null;
};

/**
 * Forgets the installation on this side. The App itself is uninstalled in
 * GitHub, which this cannot do on the workspace's behalf, so the settings page
 * links there as well.
 */
export const deleteInstallation = async (
  workspaceId: string
): Promise<void> => {
  await apiClient.delete(installationPath(workspaceId));
};

/** Lists the repositories the installation can see. */
export const listRepositories = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<GithubRepositoryRead[]> => {
  const response = await apiClient.get<GithubRepositoryRead[]>(
    repositoriesPath(workspaceId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Pins a repository to one project, or to every project with null. Pinning is
 * what stops a branch naming an issue key of a project the repository has
 * nothing to do with.
 */
export const linkRepository = async (
  workspaceId: string,
  repositoryId: string,
  projectId: string | null
): Promise<GithubRepositoryRead> => {
  const response = await apiClient.patch<GithubRepositoryRead>(
    repositoryPath(workspaceId, repositoryId),
    { project_id: projectId }
  );
  return response.data;
};

/** Lists the pull requests linked to one issue, newest first. */
export const listIssueLinks = async (
  workspaceId: string,
  issueId: string,
  query: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal
): Promise<{ items: GithubIssueLinkRead[]; next_cursor: string | null }> => {
  const response = await apiClient.get<{
    items: GithubIssueLinkRead[];
    next_cursor: string | null;
  }>(issueLinksPath(workspaceId, issueId), {
    query: { ...query },
    ...signalOptions(signal),
  });
  const body = response.data;
  return {
    items: Array.isArray(body?.items) ? body.items : [],
    next_cursor: body?.next_cursor ?? null,
  };
};

/**
 * Lists a project's transition rules. A project that has configured none gets
 * the defaults back, marked `is_default`, so the settings page can show what
 * would happen without pretending rows exist.
 */
export const listTransitions = async (
  workspaceId: string,
  projectId: string,
  signal?: AbortSignal
): Promise<TransitionRead[]> => {
  const response = await apiClient.get<TransitionRead[]>(
    transitionsPath(workspaceId, projectId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/** Creates one transition rule. */
export const createTransition = async (
  workspaceId: string,
  projectId: string,
  payload: TransitionCreate
): Promise<TransitionRead> => {
  const response = await apiClient.post<TransitionRead>(
    transitionsPath(workspaceId, projectId),
    payload
  );
  return response.data;
};

/** Changes the status one transition rule moves to. */
export const updateTransition = async (
  workspaceId: string,
  projectId: string,
  transitionId: string,
  payload: TransitionUpdate
): Promise<TransitionRead> => {
  const response = await apiClient.patch<TransitionRead>(
    transitionPath(workspaceId, projectId, transitionId),
    payload
  );
  return response.data;
};

/** Removes one transition rule. */
export const deleteTransition = async (
  workspaceId: string,
  projectId: string,
  transitionId: string
): Promise<void> => {
  await apiClient.delete(transitionPath(workspaceId, projectId, transitionId));
};

/** Lists the workspace's outbound webhook endpoints, without any secret. */
export const listWebhooks = async (
  workspaceId: string,
  signal?: AbortSignal
): Promise<WebhookEndpointRead[]> => {
  const response = await apiClient.get<WebhookEndpointRead[]>(
    webhooksPath(workspaceId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Registers an endpoint. The response carries `secret` and nothing ever will
 * again, so a caller that drops it has lost it.
 */
export const createWebhook = async (
  workspaceId: string,
  payload: WebhookEndpointCreate
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.post<WebhookEndpointRead>(
    webhooksPath(workspaceId),
    payload
  );
  return response.data;
};

/** Edits an endpoint's url, events, description or active flag. */
export const updateWebhook = async (
  workspaceId: string,
  webhookId: string,
  payload: WebhookEndpointUpdate
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.patch<WebhookEndpointRead>(
    webhookPath(workspaceId, webhookId),
    payload
  );
  return response.data;
};

/**
 * Mints a new secret for an endpoint. There is no overlap window, so a receiver
 * that has not been updated starts failing verification at once.
 */
export const rotateWebhookSecret = async (
  workspaceId: string,
  webhookId: string
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.post<WebhookEndpointRead>(
    webhookRotatePath(workspaceId, webhookId),
    {}
  );
  return response.data;
};

/** Stops delivering to an endpoint and forgets it. */
export const deleteWebhook = async (
  workspaceId: string,
  webhookId: string
): Promise<void> => {
  await apiClient.delete(webhookPath(workspaceId, webhookId));
};
