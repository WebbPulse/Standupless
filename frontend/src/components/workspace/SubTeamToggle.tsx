/**
 * The toolbar switch between a parent team's page with its sub-teams rolled
 * up and the team alone. Shared by the issue list, the cycles and the
 * projects so each reads the same way.
 */

import React from 'react';
import Button from '../ui/button';

/** Props for SubTeamToggle. */
export interface SubTeamToggleProps {
  /** True while the sub-teams are included. */
  rollUp: boolean;
  onToggle: () => void;
}

/** One button labelled with the scope the page shows now. */
export const SubTeamToggle: React.FC<SubTeamToggleProps> = ({
  rollUp,
  onToggle,
}) => (
  <Button
    size="sm"
    variant="secondary"
    aria-pressed={rollUp}
    data-testid="sub-team-roll-up"
    onClick={onToggle}
  >
    {rollUp ? 'Including sub-teams' : 'This team only'}
  </Button>
);

export default SubTeamToggle;
