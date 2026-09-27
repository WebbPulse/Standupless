/**
 * Sends the `/w/:slug/p/:keyPrefix` paths to the team routes that replaced
 * them. These addresses are in bookmarks and in links already sent, so they
 * keep working rather than reaching the not-found page.
 *
 * The old milestones path becomes the workspace projects list filtered to that
 * team, which is the nearest thing the new shape has, because projects are now
 * listed across teams rather than under one.
 */

import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import {
  projectsPath,
  teamBoardPath,
  teamCyclesPath,
  teamPath,
} from '../../lib/paths';

/** Which of a team's old surfaces the address named. */
export type LegacySurface = 'issues' | 'board' | 'cycles' | 'projects';

/** Props for LegacyTeamRedirect: which surface the old address named. */
export interface LegacyTeamRedirectProps {
  to?: LegacySurface;
}

/** Redirects one old team address to the route that replaced it. */
export const LegacyTeamRedirect: React.FC<LegacyTeamRedirectProps> = ({
  to = 'issues',
}) => {
  const { slug, keyPrefix } = useParams<{ slug: string; keyPrefix: string }>();
  const workspaceSlug = slug ?? '';
  const prefix = keyPrefix ?? '';

  const destination =
    to === 'board'
      ? teamBoardPath(workspaceSlug, prefix)
      : to === 'cycles'
        ? teamCyclesPath(workspaceSlug, prefix)
        : to === 'projects'
          ? `${projectsPath(workspaceSlug)}?team=${encodeURIComponent(prefix)}`
          : teamPath(workspaceSlug, prefix);

  return <Navigate to={destination} replace />;
};

export default LegacyTeamRedirect;
