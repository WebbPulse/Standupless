/**
 * One team's outbound webhooks. Only a team admin may read them, so anybody
 * else is told who can rather than shown a read the API refuses.
 */

import React from 'react';
import WebhooksPanel from '../webhooks/WebhooksPanel';

/** Props for TeamWebhooksSection: which team, and whether the caller may manage it. */
export interface TeamWebhooksSectionProps {
  workspaceId: string;
  teamId: string;
  canEdit: boolean;
}

/** Lists and manages the webhooks scoped to one team. */
export const TeamWebhooksSection: React.FC<TeamWebhooksSectionProps> = ({
  workspaceId,
  teamId,
  canEdit,
}) => {
  if (!canEdit) {
    return (
      <section className="space-y-1">
        <h3 className="text-base font-semibold">Webhooks</h3>
        <p className="text-sm text-text-muted">
          Only a team admin can manage this team's webhooks.
        </p>
      </section>
    );
  }

  return (
    <WebhooksPanel
      scope={{ workspaceId, teamId }}
      headingLevel={3}
      description="Send signed requests to another service when this team's issues, comments, projects, cycles or labels change."
    />
  );
};

export default TeamWebhooksSection;
