/**
 * The caller's private agent profiles: local Claude guidance an agent saved
 * through MCP so another machine can restore it. The routes read the caller's own
 * partition only, so there is no way to name another person's profile. Files are
 * not read here: restoring is what the agent and the CLI do, and the settings page
 * only lists what is kept and deletes it.
 */

import apiClient from './client';
import type {
  AgentProfileListRead,
  AgentProfileVersionListRead,
} from '../types/Api';

/** The route the caller's agent profiles are listed on. */
export const MY_AGENT_PROFILES_ROUTE = '/users/me/agent-profiles';

/** The route one of the caller's agent profiles is deleted through. */
export const myAgentProfilePath = (name: string): string =>
  `${MY_AGENT_PROFILES_ROUTE}/${encodeURIComponent(name)}`;

/** The route one profile's kept versions are listed on. */
export const myAgentProfileVersionsPath = (name: string): string =>
  `${myAgentProfilePath(name)}/versions`;

/** Passes an abort signal through only when one was given. */
const signalOptions = (
  signal?: AbortSignal
): { signal: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };

/** Lists the caller's agent profiles, answering an empty list for a malformed body. */
export const listMyAgentProfiles = async (
  signal?: AbortSignal
): Promise<AgentProfileListRead> => {
  const response = await apiClient.get<Partial<AgentProfileListRead>>(
    MY_AGENT_PROFILES_ROUTE,
    signalOptions(signal)
  );
  const body = response.data ?? {};
  return {
    profiles: Array.isArray(body.profiles) ? body.profiles : [],
    versions_kept: body.versions_kept ?? 0,
    max_profiles: body.max_profiles ?? 0,
  };
};

/** Lists one profile's kept versions, newest first. */
export const listMyAgentProfileVersions = async (
  name: string,
  signal?: AbortSignal
): Promise<AgentProfileVersionListRead> => {
  const response = await apiClient.get<AgentProfileVersionListRead>(
    myAgentProfileVersionsPath(name),
    signalOptions(signal)
  );
  return {
    ...response.data,
    versions: Array.isArray(response.data?.versions)
      ? response.data.versions
      : [],
  };
};

/** Deletes one of the caller's agent profiles and every kept version of it. */
export const deleteMyAgentProfile = async (name: string): Promise<void> => {
  await apiClient.delete(myAgentProfilePath(name));
};
