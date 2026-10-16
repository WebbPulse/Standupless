/**
 * What the Slack and Discord connection rows say about each App, kept apart
 * from the row so the component file exports only components.
 */

/** The Slack App's copy, for both the managed and the read only row. */
export const slackRowCopy = (
  slackTeamName: string | null
): { summary: string; warning: string } => ({
  summary:
    'Posts notifications to Slack channels as a bot, unfurls issue links and adds the /standupless command.',
  warning: `Standupless leaves ${slackTeamName ?? 'the Slack workspace'} for every team in this workspace. Channels that post through the Slack app stop receiving notifications, and issue links no longer unfurl. Webhook channels keep working.`,
});

/** The Discord App's copy, for both the managed and the read only row. */
export const discordRowCopy = (
  guildName: string | null
): { summary: string; warning: string } => ({
  summary:
    'Posts notifications to Discord channels as a bot and adds the /standupless command.',
  warning: `Standupless leaves ${guildName ?? 'the Discord server'} for every team in this workspace. Channels that post through the Discord app stop receiving notifications. Webhook channels keep working.`,
});
