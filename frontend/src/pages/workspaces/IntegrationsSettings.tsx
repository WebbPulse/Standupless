/**
 * The workspace integrations page, where a workspace admin connects Slack and
 * Discord once for every team and manages the workspace channels that post
 * activity from all teams, or a chosen few, to one place.
 *
 * Teams still add their own channels in team settings once an App is
 * connected. Only an owner or admin may install an App or read the workspace
 * channels, the same as the server allows, so anybody else is told so.
 */

import React, { useCallback } from 'react';
import { invalidateQueries } from '@webbpulse/api-client/react';
import ChannelsPanel from '../../components/team/ChannelsPanel';
import DiscordReturnToast from '../../components/team/DiscordReturnToast';
import SlackReturnToast from '../../components/team/SlackReturnToast';
import ChatAppConnectionRow from '../../components/workspace/ChatAppConnectionRow';
import {
  discordRowCopy,
  slackRowCopy,
} from '../../components/workspace/chatAppCopy';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import {
  deleteDiscordConnection,
  deleteSlackConnection,
  getDiscordInstallUrl,
  getSlackInstallUrl,
} from '../../api/integrations';
import { useChatApps } from '../../hooks/useChatApps';
import { useTeams } from '../../hooks/useTeams';
import { useWorkspace } from '../../hooks/useWorkspace';
import { useWorkspaceMembers } from '../../hooks/useWorkspaceMembers';
import { canManageMembers } from '../../lib/capabilities';
import { channelsKey } from '../../lib/queryKeys';
import type { MemberRead } from '../../types/Api';

/** Who added an App, by display name, or a neutral word when they left. */
const installerName = (
  members: readonly MemberRead[],
  userId: string | null | undefined
): string | null => {
  if (userId === null || userId === undefined) return null;
  const member = members.find((candidate) => candidate.user_id === userId);
  if (member === undefined) return 'a former member';
  return member.display_name ?? 'a workspace member';
};

/** The Slack and Discord connections and the workspace channels, for an admin. */
const Integrations: React.FC<{ workspaceId: string }> = ({ workspaceId }) => {
  const { slack, discord, refetchSlack, refetchDiscord } =
    useChatApps(workspaceId);
  const members = useWorkspaceMembers(workspaceId);
  const { data: teams } = useTeams();
  const slackInstalled = slack?.installed === true;
  const discordInstalled = discord?.installed === true;

  const refreshChannels = useCallback((): void => {
    invalidateQueries(channelsKey(workspaceId, null));
  }, [workspaceId]);

  const onSlackDisconnected = useCallback((): void => {
    void refetchSlack().catch(() => undefined);
    refreshChannels();
  }, [refetchSlack, refreshChannels]);

  const onDiscordDisconnected = useCallback((): void => {
    void refetchDiscord().catch(() => undefined);
    refreshChannels();
  }, [refetchDiscord, refreshChannels]);

  const offered = slack?.configured === true || discord?.configured === true;
  const loaded = slack !== null && discord !== null;

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Integrations</h3>
          <p className="text-sm text-text-muted">
            Connect Slack and Discord once for the whole workspace. Every team
            can then pick channels for its own notifications in team settings.
          </p>
        </div>
        {slack?.configured === true && (
          <ChatAppConnectionRow
            service="Slack"
            installed={slackInstalled}
            placeName={slack.slack_team_name ?? null}
            installedBy={installerName(members, slack.installed_by)}
            installedAt={slack.installed_at ?? null}
            {...slackRowCopy(slack.slack_team_name ?? null)}
            actions={{
              installUrl: () => getSlackInstallUrl(workspaceId),
              disconnect: () => deleteSlackConnection(workspaceId),
              onDisconnected: onSlackDisconnected,
            }}
          />
        )}
        {discord?.configured === true && (
          <ChatAppConnectionRow
            service="Discord"
            installed={discordInstalled}
            placeName={discord.guild_name ?? null}
            installedBy={installerName(members, discord.installed_by)}
            installedAt={discord.installed_at ?? null}
            {...discordRowCopy(discord.guild_name ?? null)}
            actions={{
              installUrl: () => getDiscordInstallUrl(workspaceId),
              disconnect: () => deleteDiscordConnection(workspaceId),
              onDisconnected: onDiscordDisconnected,
            }}
          />
        )}
        {loaded && !offered && (
          <p className="text-sm text-text-muted">
            This environment has no Slack or Discord app set up.
          </p>
        )}
      </section>

      <ChannelsPanel
        workspaceId={workspaceId}
        teamId={null}
        slackInstalled={slackInstalled}
        discordInstalled={discordInstalled}
        teams={teams ?? []}
        title="Workspace channels"
        description="Post activity from every open team, or the teams you pick, to one Slack or Discord channel."
        emptyHint="Add a channel to follow the whole workspace, such as a leadership or release channel."
        {...(slackInstalled || discordInstalled
          ? {}
          : {
              addBlockedReason:
                'Connect Slack or Discord first to add a workspace channel.',
            })}
      />
      <SlackReturnToast />
      <DiscordReturnToast />
    </div>
  );
};

/** Renders the workspace's Slack and Discord integrations for an admin. */
const IntegrationsSettings: React.FC = () => {
  const { workspace } = useWorkspace();

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      {workspace !== null &&
        (canManageMembers(workspace.role) ? (
          <Integrations workspaceId={workspace.id} />
        ) : (
          <div className="max-w-2xl">
            <p className="text-sm text-text-muted">
              Only workspace owners and admins can manage integrations.
            </p>
          </div>
        ))}
    </WorkspaceShell>
  );
};

export default IntegrationsSettings;
