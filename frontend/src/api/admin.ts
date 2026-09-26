/**
 * The platform admin routes: creating this environment's GitHub App through
 * GitHub's App manifest flow. Every route answers 404 to anyone who is not a
 * platform admin, the same as a path that does not exist.
 */

import apiClient from './client';
import type {
  GithubAppConversionCreate,
  GithubAppCreatedRead,
  GithubAppManifestRead,
  GithubAppStatusRead,
} from '../types/Api';

/** The route the App's status is read from. */
export const githubAppPath = '/admin/github-app';

/** The route a creation is started on. */
export const githubAppManifestPath = `${githubAppPath}/manifest`;

/** The route GitHub's one-time code is exchanged on. */
export const githubAppConversionsPath = `${githubAppPath}/conversions`;

/** Whether this environment already has an App and can store a new one. */
export const getGithubAppStatus = async (
  signal?: AbortSignal
): Promise<GithubAppStatusRead> => {
  const response = await apiClient.get<GithubAppStatusRead>(
    githubAppPath,
    signal === undefined ? undefined : { signal }
  );
  return response.data;
};

/**
 * Starts one creation. The state inside `post_url` expires after ten minutes
 * and works once, so it is fetched when the button is pressed rather than held.
 */
export const startGithubApp = async (): Promise<GithubAppManifestRead> => {
  const response = await apiClient.post<GithubAppManifestRead>(
    githubAppManifestPath
  );
  return response.data;
};

/**
 * Exchanges the code GitHub sent back. The server stores the App's
 * credentials itself and answers only its id and slug.
 */
export const convertGithubApp = async (
  body: GithubAppConversionCreate
): Promise<GithubAppCreatedRead> => {
  const response = await apiClient.post<GithubAppCreatedRead>(
    githubAppConversionsPath,
    body
  );
  return response.data;
};
