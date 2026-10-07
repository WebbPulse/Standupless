/**
 * The integrations routes: the GitHub App install flow, the repositories an
 * installation can see, the pull requests linked to an issue, per team
 * transition rules, a team's issue sync link, and the outbound webhooks of a
 * workspace or of one team, with their delivery logs, and the Slack and
 * Discord channels a team posts its notifications to.
 *
 * The two routes GitHub itself calls are deliberately absent. The callback is a
 * browser redirect and the webhook receiver is called by GitHub, so neither is
 * ever reached from this application.
 */

import apiClient, { isApiErrorWithStatus } from './client';
import { errorCode } from '../lib/errors';
import type {
  ChannelCreate,
  ChannelRead,
  ChannelTestRead,
  ChannelUpdate,
  GithubInstallationRead,
  GithubIssueLinkRead,
  GithubRepositoryRead,
  InstallUrlRead,
  IssueSyncRead,
  TeamSyncRead,
  TeamSyncWrite,
  TransitionCreate,
  TransitionRead,
  TransitionSet,
  TransitionUpdate,
  WebhookDeliveryRead,
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

/** The route one repository is pinned to a team through. */
export const repositoryPath = (
  workspaceId: string,
  repositoryId: string
): string => `${repositoriesPath(workspaceId)}/${repositoryId}`;

/** The route one issue's linked pull requests are read from. */
export const issueLinksPath = (workspaceId: string, issueId: string): string =>
  `/workspaces/${workspaceId}/issues/${issueId}/github-links`;

/** The route a team's transition rules are listed and created on. */
export const transitionsPath = (workspaceId: string, teamId: string): string =>
  `/workspaces/${workspaceId}/teams/${teamId}/github-transitions`;

/** The route one transition rule is edited and deleted through. */
export const transitionPath = (
  workspaceId: string,
  teamId: string,
  transitionId: string
): string => `${transitionsPath(workspaceId, teamId)}/${transitionId}`;

/** The route a team's issue sync link is read, set and removed through. */
export const teamSyncPath = (workspaceId: string, teamId: string): string =>
  `/workspaces/${workspaceId}/teams/${teamId}/github-sync`;

/** The route the GitHub issue one issue mirrors is read from. */
export const issueSyncPath = (workspaceId: string, issueId: string): string =>
  `/workspaces/${workspaceId}/issues/${issueId}/github-sync`;

/**
 * Whose webhooks a call reads or writes: the whole workspace, which sees every
 * webhook including team scoped ones, or one team, which sees only its own.
 */
export interface WebhookScope {
  workspaceId: string;
  teamId: string | null;
}

/** The route a scope's webhooks are listed and created on. */
export const webhooksPath = (scope: WebhookScope): string =>
  scope.teamId === null
    ? `/workspaces/${scope.workspaceId}/webhooks`
    : `/workspaces/${scope.workspaceId}/teams/${scope.teamId}/webhooks`;

/** The route a team's Slack and Discord channels are listed and added on. */
export const channelsPath = (workspaceId: string, teamId: string): string =>
  `/workspaces/${workspaceId}/teams/${teamId}/webhooks/channels`;

/** The route one team channel is edited and deleted through. */
export const channelPath = (
  workspaceId: string,
  teamId: string,
  channelId: string
): string => `${channelsPath(workspaceId, teamId)}/${channelId}`;

/** The route a team channel's test message is sent through. */
export const channelTestPath = (
  workspaceId: string,
  teamId: string,
  channelId: string
): string => `${channelPath(workspaceId, teamId, channelId)}/test`;

/** The route one webhook is edited and deleted through. */
export const webhookPath = (scope: WebhookScope, webhookId: string): string =>
  `${webhooksPath(scope)}/${webhookId}`;

/** The route a webhook's secret is rotated on. */
export const webhookRotatePath = (
  scope: WebhookScope,
  webhookId: string
): string => `${webhookPath(scope, webhookId)}/rotate`;

/** The route a webhook's delivery log is read from. */
export const webhookDeliveriesPath = (
  scope: WebhookScope,
  webhookId: string
): string => `${webhookPath(scope, webhookId)}/deliveries`;

/** The route a test ping is sent through. */
export const webhookPingPath = (
  scope: WebhookScope,
  webhookId: string
): string => `${webhookPath(scope, webhookId)}/ping`;

/** The route one delivery is sent again through. */
export const webhookRedeliverPath = (
  scope: WebhookScope,
  webhookId: string,
  deliveryId: string
): string =>
  `${webhookDeliveriesPath(scope, webhookId)}/${deliveryId}/redeliver`;

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
 * What reading the installation settled on. A 404 and a NOT_CONFIGURED are
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
 * not installed becomes `not_installed`, and the 409 NOT_CONFIGURED it answers
 * when the App credentials are absent from the environment becomes
 * `not_configured`, as does the 503 an older backend answered. Both
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
      (error.status === 409 || error.status === 503) &&
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
 * Pins a repository to one team, or to every team with null. Pinning is
 * what stops a branch naming an issue key of a team the repository has
 * nothing to do with.
 */
export const linkRepository = async (
  workspaceId: string,
  repositoryId: string,
  teamId: string | null
): Promise<GithubRepositoryRead> => {
  const response = await apiClient.patch<GithubRepositoryRead>(
    repositoryPath(workspaceId, repositoryId),
    { team_id: teamId }
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
 * Lists a team's transition rules. A team that has configured none gets
 * the defaults back, marked `is_default`, so the settings page can show what
 * would happen without pretending rows exist.
 */
export const listTransitions = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TransitionRead[]> => {
  const response = await apiClient.get<TransitionRead[]>(
    transitionsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/** Creates one transition rule. */
export const createTransition = async (
  workspaceId: string,
  teamId: string,
  payload: TransitionCreate
): Promise<TransitionRead> => {
  const response = await apiClient.post<TransitionRead>(
    transitionsPath(workspaceId, teamId),
    payload
  );
  return response.data;
};

/** Changes the status one transition rule moves to. */
export const updateTransition = async (
  workspaceId: string,
  teamId: string,
  transitionId: string,
  payload: TransitionUpdate
): Promise<TransitionRead> => {
  const response = await apiClient.patch<TransitionRead>(
    transitionPath(workspaceId, teamId, transitionId),
    payload
  );
  return response.data;
};

/** Replaces a team's whole rule set and answers the effective rules. */
export const replaceTransitions = async (
  workspaceId: string,
  teamId: string,
  payload: TransitionSet
): Promise<TransitionRead[]> => {
  const response = await apiClient.put<TransitionRead[]>(
    transitionsPath(workspaceId, teamId),
    payload
  );
  return Array.isArray(response.data) ? response.data : [];
};

/** Removes one transition rule. */
export const deleteTransition = async (
  workspaceId: string,
  teamId: string,
  transitionId: string
): Promise<void> => {
  await apiClient.delete(transitionPath(workspaceId, teamId, transitionId));
};

/**
 * Reads a team's issue sync link, or null when the team syncs with no
 * repository. The 404 is the resting state, not a failure.
 */
export const getTeamSync = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<TeamSyncRead | null> => {
  try {
    const response = await apiClient.get<TeamSyncRead>(
      teamSyncPath(workspaceId, teamId),
      signalOptions(signal)
    );
    return response.data ?? null;
  } catch (error) {
    if (isApiErrorWithStatus(error) && error.status === 404) return null;
    throw error;
  }
};

/**
 * Links a team to a repository, or changes the link. A repository another team
 * already syncs with answers 409.
 */
export const putTeamSync = async (
  workspaceId: string,
  teamId: string,
  payload: TeamSyncWrite
): Promise<TeamSyncRead> => {
  const response = await apiClient.put<TeamSyncRead>(
    teamSyncPath(workspaceId, teamId),
    payload
  );
  return response.data;
};

/** Stops a team syncing. Issues already mirrored keep their content. */
export const deleteTeamSync = async (
  workspaceId: string,
  teamId: string
): Promise<void> => {
  await apiClient.delete(teamSyncPath(workspaceId, teamId));
};

/** Reads the GitHub issue one issue mirrors, or null when it mirrors none. */
export const getIssueSync = async (
  workspaceId: string,
  issueId: string,
  signal?: AbortSignal
): Promise<IssueSyncRead | null> => {
  try {
    const response = await apiClient.get<IssueSyncRead>(
      issueSyncPath(workspaceId, issueId),
      signalOptions(signal)
    );
    return response.data ?? null;
  } catch (error) {
    if (isApiErrorWithStatus(error) && error.status === 404) return null;
    throw error;
  }
};

/** Lists a scope's webhooks, without any secret. */
export const listWebhooks = async (
  scope: WebhookScope,
  signal?: AbortSignal
): Promise<WebhookEndpointRead[]> => {
  const response = await apiClient.get<WebhookEndpointRead[]>(
    webhooksPath(scope),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Registers a webhook. The response carries `secret` and nothing ever will
 * again, so a caller that drops it has lost it. A private or non https URL is
 * refused with a 422, and a workspace already holding the maximum with a 409.
 */
export const createWebhook = async (
  scope: WebhookScope,
  payload: WebhookEndpointCreate
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.post<WebhookEndpointRead>(
    webhooksPath(scope),
    payload
  );
  return response.data;
};

/** Edits a webhook's URL, label, resource types, team or enabled flag. */
export const updateWebhook = async (
  scope: WebhookScope,
  webhookId: string,
  payload: WebhookEndpointUpdate
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.patch<WebhookEndpointRead>(
    webhookPath(scope, webhookId),
    payload
  );
  return response.data;
};

/**
 * Mints a new secret for a webhook. There is no overlap window, so a receiver
 * that has not been updated starts failing verification at once.
 */
export const rotateWebhookSecret = async (
  scope: WebhookScope,
  webhookId: string
): Promise<WebhookEndpointRead> => {
  const response = await apiClient.post<WebhookEndpointRead>(
    webhookRotatePath(scope, webhookId),
    {}
  );
  return response.data;
};

/** Stops delivering to a webhook and forgets it. */
export const deleteWebhook = async (
  scope: WebhookScope,
  webhookId: string
): Promise<void> => {
  await apiClient.delete(webhookPath(scope, webhookId));
};

/** Lists a webhook's most recent deliveries, newest first. */
export const listWebhookDeliveries = async (
  scope: WebhookScope,
  webhookId: string,
  signal?: AbortSignal
): Promise<WebhookDeliveryRead[]> => {
  const response = await apiClient.get<WebhookDeliveryRead[]>(
    webhookDeliveriesPath(scope, webhookId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Sends a test ping and waits for it, so the delivery that comes back already
 * carries the receiver's answer.
 */
export const pingWebhook = async (
  scope: WebhookScope,
  webhookId: string
): Promise<WebhookDeliveryRead> => {
  const response = await apiClient.post<WebhookDeliveryRead>(
    webhookPingPath(scope, webhookId),
    {}
  );
  return response.data;
};

/**
 * Sends one delivery's payload again as a new delivery, which names the
 * original in `redelivery_of`.
 */
export const redeliverWebhookDelivery = async (
  scope: WebhookScope,
  webhookId: string,
  deliveryId: string
): Promise<WebhookDeliveryRead> => {
  const response = await apiClient.post<WebhookDeliveryRead>(
    webhookRedeliverPath(scope, webhookId, deliveryId),
    {}
  );
  return response.data;
};

/** Lists a team's Slack and Discord channels, oldest first. */
export const listChannels = async (
  workspaceId: string,
  teamId: string,
  signal?: AbortSignal
): Promise<ChannelRead[]> => {
  const response = await apiClient.get<ChannelRead[]>(
    channelsPath(workspaceId, teamId),
    signalOptions(signal)
  );
  return Array.isArray(response.data) ? response.data : [];
};

/**
 * Adds a channel. A URL that is not a Slack or Discord incoming webhook is
 * refused with a 422, and a team already holding the maximum with a 409.
 */
export const createChannel = async (
  workspaceId: string,
  teamId: string,
  payload: ChannelCreate
): Promise<ChannelRead> => {
  const response = await apiClient.post<ChannelRead>(
    channelsPath(workspaceId, teamId),
    payload
  );
  return response.data;
};

/** Edits a channel's URL, label, events or enabled flag. */
export const updateChannel = async (
  workspaceId: string,
  teamId: string,
  channelId: string,
  payload: ChannelUpdate
): Promise<ChannelRead> => {
  const response = await apiClient.patch<ChannelRead>(
    channelPath(workspaceId, teamId, channelId),
    payload
  );
  return response.data;
};

/** Removes a channel. */
export const deleteChannel = async (
  workspaceId: string,
  teamId: string,
  channelId: string
): Promise<void> => {
  await apiClient.delete(channelPath(workspaceId, teamId, channelId));
};

/** Posts a test message to a channel and says whether it landed. */
export const testChannel = async (
  workspaceId: string,
  teamId: string,
  channelId: string
): Promise<ChannelTestRead> => {
  const response = await apiClient.post<ChannelTestRead>(
    channelTestPath(workspaceId, teamId, channelId),
    {}
  );
  return response.data;
};
