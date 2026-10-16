/**
 * Whether this environment offers the Slack and Discord Apps and whether the
 * workspace installed them, read once for the pages that show the connection
 * and decide which channel kinds a new channel may be.
 */

import { useQueryAuth } from '@webbpulse/auth/react';
import { usePolledQuery } from '@webbpulse/api-client/react';
import { getDiscordConnection, getSlackConnection } from '../api/integrations';
import { discordConnectionKey, slackConnectionKey } from '../lib/queryKeys';
import type { DiscordConnectionRead, SlackConnectionRead } from '../types/Api';

/** How often the connections are re-read while a settings page is open. */
const POLL_MS = 30000;

/** Both chat App connections, null until each first read lands. */
export interface ChatApps {
  slack: SlackConnectionRead | null;
  discord: DiscordConnectionRead | null;
  /** Re-reads the Slack connection, such as after a disconnect. */
  refetchSlack: () => Promise<unknown>;
  /** Re-reads the Discord connection, such as after a disconnect. */
  refetchDiscord: () => Promise<unknown>;
}

/** Reads the workspace's Slack and Discord connections. */
export const useChatApps = (workspaceId: string, enabled = true): ChatApps => {
  const auth = useQueryAuth();
  const active = enabled && workspaceId !== '';
  const slack = usePolledQuery(
    ({ signal }) => getSlackConnection(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: active,
      queryKey: slackConnectionKey(workspaceId),
      auth,
    }
  );
  const discord = usePolledQuery(
    ({ signal }) => getDiscordConnection(workspaceId, signal),
    {
      intervalMs: POLL_MS,
      enabled: active,
      queryKey: discordConnectionKey(workspaceId),
      auth,
    }
  );
  return {
    slack: slack.data,
    discord: discord.data,
    refetchSlack: slack.refetch,
    refetchDiscord: discord.refetch,
  };
};

export default useChatApps;
