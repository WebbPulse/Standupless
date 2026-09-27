/**
 * The workspace's outbound webhooks, every team's included. A workspace admin
 * may point a webhook at all teams or at one, so the team picker and the team
 * badge on each row appear here and not on a team's own settings page.
 */

import React from 'react';
import { useTeamsFor } from '../../hooks/useTeams';
import type { WorkspaceRead } from '../../types/Api';
import WebhooksPanel from '../webhooks/WebhooksPanel';

/** Props for WebhooksSection: the workspace whose webhooks are shown. */
export interface WebhooksSectionProps {
  workspace: WorkspaceRead;
}

/** Lists and manages every webhook in the workspace. */
export const WebhooksSection: React.FC<WebhooksSectionProps> = ({
  workspace,
}) => {
  const { data: teams } = useTeamsFor(workspace.id);

  return (
    <WebhooksPanel
      scope={{ workspaceId: workspace.id, teamId: null }}
      teams={teams ?? []}
      description="Send signed requests to another service when issues, comments, projects, cycles or labels change, in every team or in one."
    />
  );
};

export default WebhooksSection;
