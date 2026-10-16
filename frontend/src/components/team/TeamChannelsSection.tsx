/**
 * The Slack and Discord channels one team posts its notifications to.
 *
 * The Slack and Discord Apps are installed once for the whole workspace, on
 * the workspace integrations page, so this section shows each connection read
 * only with a link there. Once one is installed, a team admin picks the
 * channels its bot posts this team's activity to; a webhook channel works
 * without either.
 *
 * Only a team admin may read the channels, so anybody else is told who can
 * rather than shown a read the API refuses.
 */

import React from 'react';
import { useChatApps } from '../../hooks/useChatApps';
import { integrationsSettingsPath } from '../../lib/paths';
import ChatAppConnectionRow from '../workspace/ChatAppConnectionRow';
import { discordRowCopy, slackRowCopy } from '../workspace/chatAppCopy';
import ChannelsPanel from './ChannelsPanel';

/** Props for TeamChannelsSection: which team, and whether the caller may manage it. */
export interface TeamChannelsSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
  /** Whether the caller administers the workspace, which connecting a chat App takes. */
  canManageWorkspace?: boolean;
  /** The workspace's slug, for the link to its integrations page. */
  workspaceSlug?: string;
}

/** The team's channels, under the read only Slack and Discord connections. */
const TeamChannels: React.FC<Omit<TeamChannelsSectionProps, 'canEdit'>> = ({
  workspaceId,
  teamId,
  canManageWorkspace = false,
  workspaceSlug,
}) => {
  const { slack, discord } = useChatApps(workspaceId);
  const slackInstalled = slack?.installed === true;
  const discordInstalled = discord?.installed === true;
  const manageHref =
    workspaceSlug === undefined
      ? undefined
      : integrationsSettingsPath(workspaceSlug);

  return (
    <ChannelsPanel
      workspaceId={workspaceId}
      teamId={teamId}
      slackInstalled={slackInstalled}
      discordInstalled={discordInstalled}
      title="Notifications"
      description="Post this team's issue, comment and project update activity to Slack or Discord channels."
      emptyHint={
        slackInstalled || discordInstalled
          ? 'Add a channel the app posts to, or a Slack or Discord incoming webhook, to post issue and project update activity there.'
          : 'Add a Slack incoming webhook or a Discord channel webhook, or connect Slack or Discord in workspace settings to pick channels by name.'
      }
    >
      {slack?.configured === true && (
        <ChatAppConnectionRow
          service="Slack"
          installed={slackInstalled}
          placeName={slack.slack_team_name ?? null}
          installedAt={slack.installed_at ?? null}
          {...slackRowCopy(slack.slack_team_name ?? null)}
          canManage={canManageWorkspace}
          {...(manageHref === undefined ? {} : { manageHref })}
        />
      )}
      {discord?.configured === true && (
        <ChatAppConnectionRow
          service="Discord"
          installed={discordInstalled}
          placeName={discord.guild_name ?? null}
          installedAt={discord.installed_at ?? null}
          {...discordRowCopy(discord.guild_name ?? null)}
          canManage={canManageWorkspace}
          {...(manageHref === undefined ? {} : { manageHref })}
        />
      )}
    </ChannelsPanel>
  );
};

/** Lists and manages the Slack and Discord channels of one team. */
export const TeamChannelsSection: React.FC<TeamChannelsSectionProps> = ({
  canEdit,
  ...props
}) => {
  if (!canEdit) {
    return (
      <section className="space-y-1">
        <h3 className="text-base font-semibold">Notifications</h3>
        <p className="text-sm text-text-muted">
          Only a team admin can manage this team&apos;s Slack and Discord
          channels.
        </p>
      </section>
    );
  }
  return <TeamChannels {...props} />;
};

export default TeamChannelsSection;
