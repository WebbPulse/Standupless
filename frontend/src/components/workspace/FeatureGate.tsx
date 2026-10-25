/**
 * The layout route around an optional area's pages. While the workspace has
 * the area on, the page renders as usual. While it is off, the route shows a
 * page saying an admin turned it off rather than a 404, so a saved link or a
 * favorite explains itself, and an admin gets a link straight to the switch.
 */

import React from 'react';
import { Link, Outlet } from 'react-router-dom';
import { useWorkspace } from '../../hooks/useWorkspace';
import { canManageMembers } from '../../lib/capabilities';
import { featureLabel, isFeatureOn } from '../../lib/features';
import { featuresSettingsPath } from '../../lib/paths';
import type { WorkspaceFeature } from '../../types/Api';
import EmptyState from '../ui/empty-state';
import WorkspaceShell from './WorkspaceShell';

/** Props for FeatureGate: the area the wrapped routes belong to. */
export interface FeatureGateProps {
  feature: WorkspaceFeature;
}

/** What an area's route shows while the workspace has the area off. */
export const FeatureTurnedOff: React.FC<FeatureGateProps> = ({ feature }) => {
  const { workspace } = useWorkspace();
  const label = featureLabel(feature);
  return (
    <WorkspaceShell title={label}>
      <EmptyState
        message={`${label} is turned off by an admin for this workspace. Everything in it is kept and comes back when it is turned on again.`}
        action={
          workspace !== null && canManageMembers(workspace.role) ? (
            <Link
              to={featuresSettingsPath(workspace.slug)}
              className="text-sm text-accent hover:underline"
            >
              Open feature settings
            </Link>
          ) : undefined
        }
      />
    </WorkspaceShell>
  );
};

/** Renders the matched page while the area is on, and the turned off page while it is not. */
export const FeatureGate: React.FC<FeatureGateProps> = ({ feature }) => {
  const { workspace } = useWorkspace();
  if (workspace !== null && !isFeatureOn(workspace, feature)) {
    return <FeatureTurnedOff feature={feature} />;
  }
  return <Outlet />;
};

export default FeatureGate;
